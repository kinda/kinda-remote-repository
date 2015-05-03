"use strict";


var http = require('http');
require('co-mocha');
var assert = require('chai').assert;
var _ = require('lodash');
var koa = require('koa');
var router = require('koa-router');
var body = require('koa-body');
var util = require('kinda-util').create();
var Collection = require('kinda-collection');
var KindaRemoteRepository = require('./');

suite('KindaRemoteRepository', function() {
  var httpServer, repository, users, superusers;

  var catchError = function *(fn) {
    var err;
    try {
      yield fn();
    } catch (e) {
      err = e
    }
    return err;
  };

  suiteSetup(function *() {
    var serverPort = 8888;

    var server = koa();
    server.use(body());
    server.use(router(server));

    server.post('/authorizations', function *() {
      var credentials = this.request.body;
      if (!credentials) {
        this.status = 403;
        return;
      }
      if (credentials.username !== 'mvila@3base.com') {
        this.status = 403;
        return;
      }
      if (credentials.password !== 'password') {
        this.status = 403;
        return;
      }
      this.status = 201;
      this.type = 'application/json';
      this.body = JSON.stringify('12345678');
    });

    server.get('/authorizations/12345678', function *() {
      this.status = 204;
    });

    server.del('/authorizations/12345678', function *() {
      this.status = 204;
    });

    server.get('/authorizations/abcdefgh', function *() {
      this.status = 403;
    });

    server.get('/get-repository-id', function *() {
      this.type = 'application/json';
      this.body = JSON.stringify('a1b2c3d4e5');
    });

    server.get('/users/007', function *() {
      var query = util.decodeObject(this.query);
      if (query.authorization !== '12345678')  {
        this.status = 403;
        return;
      }
      this.body = {
        class: 'User',
        value: { id: '007', firstName: 'James', age: 39 }
      };
    });

    server.get('/users/aaa', function *() {
      this.body = {
        class: 'Superuser',
        value: { id: 'aaa', firstName: 'Manu', age: 42, superpower: 'telepathy' }
      };
    });

    server.get('/users/xyz', function *() {
      var query = util.decodeObject(this.query);
      if (query.errorIfMissing == null) query.errorIfMissing = true;
      this.status = query.errorIfMissing ? 404 : 204;
    });

    server.post('/users', function *() {
      var user = this.request.body;
      user.id = 'bbb';
      this.status = 201;
      this.body = { class: 'User', value: user };
    });

    server.put('/users/bbb', function *() {
      var user = this.request.body;
      this.body = { class: 'User', value: user };
    });

    server.del('/users/ccc', function *() {
      this.status = 204;
    });

    server.del('/users/xyz', function *() {
      var query = util.decodeObject(this.query);
      if (query.errorIfMissing == null) query.errorIfMissing = true;
      this.status = query.errorIfMissing ? 404 : 204;
    });

    server.post('/users/get-items', function *() {
      var ids = this.request.body;
      var results = ids.map(function(id) {
        switch (id) {
          case 'aaa':
            return {
              class: 'Superuser',
              value: { id: 'aaa', firstName: 'Manu', age: 42, superpower: 'telepathy' }
            };
          case 'bbb':
            return {
              class: 'User',
              value: { id: 'bbb', firstName: 'Vince', age: 43 }
            };
          default:
            throw new Error('item not found');
        }
      });
      this.status = 201;
      this.body = results;
    });

    server.get('/users', function *() {
      this.body = [
        {
          class: 'Superuser',
          value: { id: 'aaa', firstName: 'Manu', age: 42, superpower: 'telepathy' }
        },
        {
          class: 'User',
          value: { id: 'bbb', firstName: 'Vince', age: 43 }
        }
      ];
    });

    server.del('/users', function *() {
      this.status = 204;
    });

    server.get('/users/count', function *() {
      this.body = 2;
    });

    server.get('/users/count-retired', function *() {
      this.body = 3;
    });

    server.get('/superusers/aaa/archive', function *() {
      this.body = { ok: true };
    });

    server.post('/users/restore', function *() {
      this.status = 201;
      this.body = this.request.body;
    });

    httpServer = http.createServer(server.callback());
    httpServer.listen(serverPort);

    var Users = Collection.extend('Users', function() {
      this.Item = this.Item.extend('User', function() {
        this.addPrimaryKeyProperty('id', String);
        this.addProperty('firstName', String);
        this.addProperty('age', Number);
        this.archive = function *() {
          return yield this.call('archive');
        };
      });
      this.countRetired = function *() {
        return yield this.call('countRetired');
      };
      this.restore = function *(archive) {
        return yield this.call('restore', undefined, archive);
      };
    });

    var Superusers = Users.extend('Superusers', function() {
      this.Item = this.Item.extend('Superuser', function() {
        this.addProperty('superpower', String);
      });
    });

    var serverURL = 'http://localhost:' + serverPort;
    repository = KindaRemoteRepository.create('Test', serverURL,
      [Users, Superusers]
    );

    users = repository.createCollection('Users');
    superusers = repository.createCollection('Superusers');
  });

  suiteTeardown(function *() {
    httpServer.close();
  });

  test('test authorization', function *() {
    var repository = users.getRepository();

    assert.isFalse(repository.isSignedIn());
    var credentials = { username: 'mvila@3base.com', password: 'wrongpass' };
    var authorization = yield repository.signInWithCredentials(credentials);
    assert.isUndefined(authorization);
    assert.isFalse(repository.isSignedIn());

    var err = yield catchError(function *() {
      yield users.getItem('007');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 403);

    assert.isFalse(repository.isSignedIn());
    var credentials = { username: 'mvila@3base.com', password: 'password' };
    var authorization = yield repository.signInWithCredentials(credentials);
    assert.ok(authorization);
    assert.isTrue(repository.isSignedIn());

    var item = yield users.getItem('007');
    assert.strictEqual(item.id, '007');
    assert.strictEqual(item.firstName, 'James');
    assert.strictEqual(item.age, 39);

    assert.isTrue(repository.isSignedIn());
    yield repository.signOut();
    assert.isFalse(repository.isSignedIn());

    var err = yield catchError(function *() {
      yield users.getItem('007');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 403);

    assert.isFalse(repository.isSignedIn());
    var authorization = yield repository.signInWithAuthorization('abcdefgh');
    assert.isFalse(authorization);
    assert.isFalse(repository.isSignedIn());

    assert.isFalse(repository.isSignedIn());
    var authorization = yield repository.signInWithAuthorization('12345678');
    assert.isTrue(authorization);
    assert.isTrue(repository.isSignedIn());

    var item = yield users.getItem('007');
    assert.ok(item);

    yield repository.signOut();
  });

  test('get repository id', function *() {
    var id = yield repository.getRepositoryId();
    assert.strictEqual(id, 'a1b2c3d4e5');
  });

  test('get an item', function *() {
    var item = yield users.getItem('aaa');
    assert.strictEqual(item.getClassName(), 'Superuser');
    assert.strictEqual(item.id, 'aaa');
    assert.strictEqual(item.firstName, 'Manu');
    assert.strictEqual(item.age, 42);
    assert.strictEqual(item.superpower, 'telepathy');

    var err = yield catchError(function *() {
      yield users.getItem('xyz');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 404);

    var item = yield users.getItem('xyz', { errorIfMissing: false });
    assert.isUndefined(item);
  });

  test('put an item', function *() {
    var item = users.createItem({ firstName: 'Vince', age: 43 });
    yield item.save();
    assert.strictEqual(item.id, 'bbb');
    assert.strictEqual(item.firstName, 'Vince');
    assert.strictEqual(item.age, 43);

    item.age++;
    yield item.save();
    assert.strictEqual(item.id, 'bbb');
    assert.strictEqual(item.firstName, 'Vince');
    assert.strictEqual(item.age, 44);
  });

  test('delete an item', function *() {
    var err = yield catchError(function *() {
      yield users.deleteItem('ccc');
    });
    assert.isUndefined(err);

    var err = yield catchError(function *() {
      yield users.deleteItem('xyz');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 404);

    var err = yield catchError(function *() {
      yield users.deleteItem('xyz', { errorIfMissing: false });
    });
    assert.isUndefined(err);
  });

  test('get several items at once', function *() {
    var items = yield users.getItems(['aaa', 'bbb']);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].getClassName(), 'Superuser');
    assert.strictEqual(items[0].id, 'aaa');
    assert.strictEqual(items[0].firstName, 'Manu');
    assert.strictEqual(items[0].age, 42);
    assert.strictEqual(items[0].superpower, 'telepathy');
    assert.strictEqual(items[1].getClassName(), 'User');
    assert.strictEqual(items[1].id, 'bbb');
    assert.strictEqual(items[1].firstName, 'Vince');
    assert.strictEqual(items[1].age, 43);
  });

  test('find items', function *() {
    var items = yield users.findItems();
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].getClassName(), 'Superuser');
    assert.strictEqual(items[0].id, 'aaa');
    assert.strictEqual(items[0].firstName, 'Manu');
    assert.strictEqual(items[0].age, 42);
    assert.strictEqual(items[0].superpower, 'telepathy');
    assert.strictEqual(items[1].getClassName(), 'User');
    assert.strictEqual(items[1].id, 'bbb');
    assert.strictEqual(items[1].firstName, 'Vince');
    assert.strictEqual(items[1].age, 43);
  });

  test('count items', function *() {
    var count = yield users.countItems();
    assert.strictEqual(count, 2);
  });

  test('find and delete items', function *() {
    yield users.findAndDeleteItems({ start: 'bbb', end: 'ddd' });
  });

  test('call custom method on a collection', function *() {
    var count = yield users.countRetired();
    assert.strictEqual(count, 3);
  });

  test('call custom method on an item', function *() {
    var item = yield users.getItem('aaa');
    var result = yield item.archive();
    assert.isTrue(result.ok);
  });

  test('call custom method with a body', function *() {
    var archive = [{ id: 'aaa', firstName: 'Manu', age: 42 }];
    var result = yield users.restore(archive);
    assert.deepEqual(result, archive);
  });
});
