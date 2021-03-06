#!/usr/bin/env node
'use strict'
const fs = require('fs')
const ldap = require('ldapjs')
const AWS = require('aws-sdk')
const peercred = require('peercred')
const crypto = require('crypto')
const hash = crypto.createHash('sha256')

const iamEpoch = (new Date('2010-01-01')).getTime()

// get as much uniqness as possible from a short string
// this produces 3 hashes with more that 75 collisions from /usr/share/dict/words
const shortHash = (s) => String(s).split('').reduce((p, c) => p ^ Math.pow(c.charCodeAt(), 2), 0x3fff)

let secret

if (process.env.SECRET) {
  secret = process.env.SECRET
} else {
  hash.update(Array.from('0123456789').map(a => Math.floor(Math.random() * 100)).join(''))
  secret = hash.digest('hex')
  console.log('using secret:', secret)
}

AWS.config.update({region: process.env.AWS_REGION})

let iam = new AWS.IAM({apiVersion: '2010-05-08'})

let server = ldap.createServer()

const domain = process.env.DOMAIN.split('.').map(dc => 'dc=' + dc.toLowerCase()).join(',')

function authorize (req, res, next) {
  if (isNaN(parseInt(process.env.PORT))) {
    let credentials = peercred.fromSock(req.connection)
    if ((process.env.REQUIRE_UID && credentials.uid === parseInt(process.env.REQUIRE_UID)) ||
        (process.env.REQUIRE_GID && credentials.gid === parseInt(process.env.REQUIRE_GID))) {
      return next()
    } else {
      console.log('UID or GID mismatch', credentials)
      return next(new ldap.InsufficientAccessRightsError())
    }
  }
  if (!req.connection.ldap.bindDN.equals('cn=root')) {
    console.log('user not bound or insufficent rights, try as cn=root')
    return next(new ldap.InsufficientAccessRightsError())
  }
  return next()
}

server.bind('cn=root', function (req, res, next) {
  if (req.dn.toString() !== 'cn=root' || req.credentials !== secret) {
    return next(new ldap.InvalidCredentialsError())
  }

  res.end()
  return next()
})

server.bind('cn=local', function (req, res, next) {
  res.end()
  return next()
})

function getUsers (req, res, next) {
  if (!process.env.GROUP_NAME) {
    return next()
  }
  if (!req.users) {
    req.users = {}
  }
  let opts = { GroupName: process.env.GROUP_NAME }
  if (req.marker) {
    opts.Marker = req.marker
  }
  iam.getGroup(opts, (err, data) => {
    if (err) {
      console.log(err)
      return next(new ldap.UnavailableError())
    }
    data.Users
      .sort((a, b) => a.CreateDate > b.CreateDate) // new users last, only a problem when someone gets deleted
      .forEach(user => {
        let username = user.Path.replace(/\//g, '')
        if (username.length) {
          req.users[username] = {
            dn: 'cn=' + username + ',ou=users,' + domain,
            attributes: {
              cn: username,
              name: user.UserName,
              path: user.Path,
              uri: user.Arn,
              shell: '/bin/bash',
              homedirectory: '/home/' + username,
              uid: username,
              // best effort at unique uids above 16bits
              uidNumber: Math.floor((user.CreateDate.getTime() - iamEpoch) / 1000) ^ shortHash(user.UserName),
              gidNumber: process.env.DEFAULT_GID || 500,
              objectclass: ['unixUser', 'posixAccount']
            }
          }
        }
      })
    if (data.IsTruncated) {
      req.marker = data.Marker
      getUsers(req, res, next)
    } else {
      next()
    }
  })
}

server.search(domain, authorize, getUsers, function (req, res, next) {
  if (!req.users) {
    console.log('no users found')
    return next(new ldap.UnavailableError())
  }
  Object.keys(req.users).forEach(function (k) {
    if (req.filter.matches(req.users[k].attributes)) {
      res.send(req.users[k])
    }
  })

  res.end()
})

function start () {
  server.listen(process.env.PORT || 1389, function () {
    console.log('ldapjs listening at ' + server.url)
    console.log(Math.abs(parseInt(process.env.REQUIRE_UID || process.getuid())),
        Math.abs(parseInt(process.env.REQUIRE_GID || process.getgid())), 'woo')
    if (isNaN(parseInt(process.env.PORT))) {
      fs.chown(
        process.env.PORT,
        parseInt(process.env.REQUIRE_UID || process.getuid()),
        parseInt(process.env.REQUIRE_GID || process.getgid()),
        () => {})
      fs.chmod(
        process.env.PORT,
        parseInt('0775', 8),
        () => {})
    }
  })
}

if (isNaN(parseInt(process.env.PORT))) {
  // attempt to remove socket file, ignore exceptions
  fs.unlink(process.env.PORT, () => start())
} else {
  start()
}
