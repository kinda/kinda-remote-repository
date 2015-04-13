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
  var httpServer, users;

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

    server.get('/users/007', function *() {
      var query = util.decodeObject(this.query);
      if (query.authorization !== '12345678') this.throw(403);
      this.body = { id: '007', firstName: 'James', age: 39 };
    });

    server.get('/users/aaa', function *() {
      this.body = { id: 'aaa', firstName: 'Manu', age: 42 };
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
      this.body = user;
    });

    server.put('/users/bbb', function *() {
      var user = this.request.body;
      this.body = user;
    });

    server.del('/users/ccc', function *() {
      this.status = 204;
    });

    server.del('/users/xyz', function *() {
      var query = util.decodeObject(this.query);
      if (query.errorIfMissing == null) query.errorIfMissing = true;
      this.status = query.errorIfMissing ? 404 : 204;
    });

    server.get('/users', function *() {
      this.body = [
        { id: 'aaa', firstName: 'Manu', age: 42 },
        { id: 'bbb', firstName: 'Vince', age: 43 }
      ];
    });

    server.get('/users/count', function *() {
      this.body = 2;
    });

    httpServer = http.createServer(server.callback());
    httpServer.listen(serverPort);

    var serverURL = 'http://localhost:' + serverPort;
    var repository = KindaRemoteRepository.create(serverURL);
    repository.setAuthorization('12345678');

    var Users = Collection.extend('Users', function() {
      this.Item = this.Item.extend('User', function() {
        this.addPrimaryKeyProperty('id', String);
        this.addProperty('firstName', String);
        this.addProperty('age', Number);
      });
      this.setRepository(repository);
    });

    users = Users.create();
  });

  suiteTeardown(function *() {
    httpServer.close();
  });

  test('authorization', function *() {
    var item = yield users.getItem('007');
    assert.strictEqual(item.id, '007');
    assert.strictEqual(item.firstName, 'James');
    assert.strictEqual(item.age, 39);
  });

  test('get an item', function *() {
    var item = yield users.getItem('aaa');
    assert.strictEqual(item.id, 'aaa');
    assert.strictEqual(item.firstName, 'Manu');
    assert.strictEqual(item.age, 42);

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

  test('find items', function *() {
    var items = yield users.findItems();
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, 'aaa');
    assert.strictEqual(items[0].firstName, 'Manu');
    assert.strictEqual(items[0].age, 42);
    assert.strictEqual(items[1].id, 'bbb');
    assert.strictEqual(items[1].firstName, 'Vince');
    assert.strictEqual(items[1].age, 43);
  });

  test('count items', function *() {
    var count = yield users.countItems();
    assert.strictEqual(count, 2);
  });
});
