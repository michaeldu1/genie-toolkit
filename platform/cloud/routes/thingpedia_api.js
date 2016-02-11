// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingPedia
//
// Copyright 2015 The Mobisocial Stanford Lab <mobisocial@lists.stanford.edu>
//
// See COPYING for details


var Q = require('q');
var express = require('express');

var db = require('../util/db');
var device = require('../model/device');
var app = require('../model/app');
var user = require('../model/user');
var schema = require('../model/schema');

var discovery_modules = {
    //bluetooth: require('../discovery/bluetooth')
};

var router = express.Router();

router.get('/schema/:schemas', function(req, res) {
    var schemas = req.params.schemas.split(',');
    if (schemas.length === 0) {
        res.json({});
        return;
    }

    db.withClient(function(dbClient) {
        return Q.try(function() {
            var developerKey = req.query.developer_key;

            if (developerKey)
                return user.getByDeveloperKey(dbClient, developerKey);
            else
                return [];
        }).then(function(developers) {
            var developer = null;
            if (developers.length > 0)
                developer = developers[0];

            return schema.getTypesByKinds(dbClient, schemas, developer).then(function(rows) {
                var obj = {};

                rows.forEach(function(row) {
                    if (row.types === null)
                        return;
                    obj[row.kind] = {
                        triggers: row.types[0],
                        actions: row.types[1]
                    };
                });

                res.json(obj);
            });
        }).catch(function(e) {
            res.status(500).send('Error: ' + e.message);
        });
    }).done();
});

function deviceMakeFactory(d) {
    var ast = JSON.parse(d.code);

    delete d.code;
    if (ast.auth.type === 'builtin') {
        d.factory = null;
    } else if (ast.auth.type === 'oauth2' ||
        (Object.keys(ast.params).length === 0 && ast.auth.type === 'none')) {
        d.factory = ({ type: 'oauth2', text: d.name });
    } else {
        d.factory = ({ type: 'form',
                       fields: Object.keys(ast.params).map(function(k) {
                           var p = ast.params[k];
                           return ({ name: k, label: p[0], type: p[1] });
                       })
                     });
    }
}

router.get('/devices', function(req, res) {
    if (req.query.class && ['online', 'physical'].indexOf(req.query.class) < 0) {
        res.status(404).json("Invalid device class");
        return;
    }

    db.withClient(function(dbClient) {
        return Q.try(function() {
            var developerKey = req.query.developer_key;

            if (developerKey)
                return user.getByDeveloperKey(dbClient, developerKey);
            else
                return [];
        }).then(function(developers) {
            var developer = null;
            if (developers.length > 0)
                developer = developers[0];

            var devices;
            if (req.query.class) {
                if (req.query.class === 'online')
                    devices = device.getAllApprovedWithKindWithCode(dbClient,
                                                                    'online-account',
                                                                    developer);
                else
                    devices = device.getAllApprovedWithoutKindWithCode(dbClient,
                                                                       'online-account',
                                                                       developer);
            } else {
                devices = device.getAllApprovedWithCode(dbClient, developer);
            }

            return devices.then(function(devices) {
                devices.forEach(function(d) {
                    try {
                        deviceMakeFactory(d);
                    } catch(e) {}
                });
                devices = devices.filter(function(d) {
                    return !!d.factory;
                });
                res.json(devices);
            });
        });
    }).done();
});

const LEGACY_MAPS = {
    'linkedin': 'com.linkedin'
};

router.get('/code/devices/:kind', function(req, res) {
    if (req.params.kind in LEGACY_MAPS)
        req.params.kind = LEGACY_MAPS[req.params.kind];

    db.withClient(function(dbClient) {
        return Q.try(function() {
            var developerKey = req.query.developer_key;

            if (developerKey)
                return user.getByDeveloperKey(dbClient, developerKey);
            else
                return [];
        }).then(function(developers) {
            var developer = null;
            if (developers.length > 0)
                developer = developers[0];

            return device.getFullCodeByPrimaryKind(dbClient, req.params.kind, developer)
                .then(function(devs) {
                    if (devs.length < 1) {
                        res.status(404).send('Not Found');
                        return;
                    }
                    var dev = devs[0];

                    var ast = JSON.parse(dev.code);
                    ast.version = dev.version;
                    if (dev.version !== dev.approved_version) {
                        res.cacheFor(3600000);
                        ast.developer = true;
                    } else {
                        res.cacheFor(86400000);
                        ast.developer = false;
                    }
                    res.status(200).json(ast);
                });
        });
    }).catch(function(e) {
        console.log('Failed to retrieve device code: ' + e.message);
        console.log(e.stack);
        res.status(400).send('Bad Request');
    }).done();
});

router.get('/code/apps/:id', function(req, res) {
    db.withClient(function(dbClient) {
        return app.get(dbClient, req.params.id).then(function(app) {
            res.cacheFor(86400000);
            res.status(200).json({
                code: app.code,
                name: app.name,
                description: app.description
            });
        });
    }).catch(function(e) {
        res.json({ error: e.message });
    });
});
router.post('/discovery', function(req, res) {
    Q.try(function() {
        if (!(req.body.kind in discovery_modules)) {
            res.status(404).send('Not Found');
            return;
        }

        var module = discovery_modules[req.body.kind];

        return module.decode(req.body).then(function(result) {
            if (result === null) {
                res.status(404).send('Not Found');
                return;
            }

            res.status(200).send(result.primary_kind);
        });
    }).catch(function(e) {
        console.log('Failed to complete discovery request: ' + e.message);
        console.log(e.stack);
        res.status(400).send('Bad Request');
    });
});

module.exports = router;
