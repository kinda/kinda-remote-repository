'use strict';


let http = require('http');
require('co-mocha');
let assert = require('chai').assert;
let koa = require('koa');
let koaRouter = require('koa-router');
let body = require('koa-body');
let util = require('kinda-util').create();
let Collection = require('kinda-collection');
let KindaRemoteRepository = require('./src');

suite('KindaRemoteRepository', function() {
  let httpServer, repository, users;

  let catchError = function *(fn) {
    let err;
    try {
      yield fn();
    } catch (e) {
      err = e;
    }
    return err;
  };

  suiteSetup(function *() {
    let serverPort = 8888;

    let server = koa();
    server.use(body());
    let router = koaRouter();
    server.use(router.routes());
    server.use(router.allowedMethods());

    router.post('/authorizations', function *() {
      let credentials = this.request.body;
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

    router.get('/authorizations/12345678', function *() {
      this.status = 204;
    });

    router.del('/authorizations/12345678', function *() {
      this.status = 204;
    });

    router.get('/authorizations/abcdefgh', function *() {
      this.status = 403;
    });

    router.get('/', function *() {
      this.body = {
        repositoryId: 'a1b2c3d4e5'
      };
    });

    router.get('/users/007', function *() {
      let query = util.decodeValue(this.query);
      if (query.authorization !== '12345678') {
        this.status = 403;
        return;
      }
      this.body = {
        class: 'User',
        value: { id: '007', firstName: 'James', age: 39 }
      };
    });

    router.get('/users/aaa', function *() {
      this.body = {
        class: 'Superuser',
        value: { id: 'aaa', firstName: 'Manu', age: 42, superpower: 'telepathy' }
      };
    });

    router.get('/users/xyz', function *() {
      let query = util.decodeValue(this.query);
      if (query.errorIfMissing == null) query.errorIfMissing = true;
      this.status = query.errorIfMissing ? 404 : 204;
    });

    router.post('/users', function *() {
      let user = this.request.body;
      user.id = 'bbb';
      this.status = 201;
      this.body = { class: 'User', value: user };
    });

    router.put('/users/bbb', function *() {
      let user = this.request.body;
      this.body = { class: 'User', value: user };
    });

    router.del('/users/ccc', function *() {
      this.body = 1;
    });

    router.del('/users/xyz', function *() {
      let query = util.decodeValue(this.query);
      if (query.errorIfMissing == null) query.errorIfMissing = true;
      if (query.errorIfMissing) {
        this.status = 404;
      } else {
        this.body = 0;
      }
    });

    router.post('/users/get-items', function *() {
      let ids = this.request.body;
      let results = ids.map(function(id) {
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

    router.get('/users', function *() {
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

    router.del('/users', function *() {
      this.body = 3;
    });

    router.get('/users/count', function *() {
      this.body = 2;
    });

    router.get('/users/count-retired', function *() {
      this.body = 3;
    });

    router.get('/superusers/aaa/archive', function *() {
      this.body = { ok: true };
    });

    router.post('/users/restore', function *() {
      this.status = 201;
      this.body = this.request.body;
    });

    httpServer = http.createServer(server.callback());
    httpServer.listen(serverPort);

    let Users = Collection.extend('Users', function() {
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

    let Superusers = Users.extend('Superusers', function() {
      this.Item = this.Item.extend('Superuser', function() {
        this.addProperty('superpower', String);
      });
    });

    let serverURL = 'http://localhost:' + serverPort;
    repository = KindaRemoteRepository.create({
      name: 'Test',
      url: serverURL,
      collections: [Users, Superusers]
    });

    users = repository.createCollection('Users');
  });

  suiteTeardown(function *() {
    httpServer.close();
  });

  test('test authorization', function *() {
    assert.isFalse(repository.isSignedIn);
    let credentials = { username: 'mvila@3base.com', password: 'wrongpass' };
    let authorization = yield repository.signInWithCredentials(credentials);
    assert.isUndefined(authorization);
    assert.isFalse(repository.isSignedIn);

    let err = yield catchError(function *() {
      yield users.getItem('007');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 403);

    assert.isFalse(repository.isSignedIn);
    credentials = { username: 'mvila@3base.com', password: 'password' };
    authorization = yield repository.signInWithCredentials(credentials);
    assert.ok(authorization);
    assert.isTrue(repository.isSignedIn);

    let item = yield users.getItem('007');
    assert.strictEqual(item.id, '007');
    assert.strictEqual(item.firstName, 'James');
    assert.strictEqual(item.age, 39);

    assert.isTrue(repository.isSignedIn);
    yield repository.signOut();
    assert.isFalse(repository.isSignedIn);

    err = yield catchError(function *() {
      yield users.getItem('007');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 403);

    assert.isFalse(repository.isSignedIn);
    authorization = yield repository.signInWithAuthorization('abcdefgh');
    assert.isFalse(authorization);
    assert.isFalse(repository.isSignedIn);

    assert.isFalse(repository.isSignedIn);
    authorization = yield repository.signInWithAuthorization('12345678');
    assert.isTrue(authorization);
    assert.isTrue(repository.isSignedIn);

    item = yield users.getItem('007');
    assert.ok(item);

    yield repository.signOut();
  });

  test('get repository id', function *() {
    let id = yield repository.getRepositoryId();
    assert.strictEqual(id, 'a1b2c3d4e5');
  });

  test('get an item', function *() {
    let item = yield users.getItem('aaa');
    assert.strictEqual(item.class.name, 'Superuser');
    assert.strictEqual(item.id, 'aaa');
    assert.strictEqual(item.firstName, 'Manu');
    assert.strictEqual(item.age, 42);
    assert.strictEqual(item.superpower, 'telepathy');

    let err = yield catchError(function *() {
      yield users.getItem('xyz');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 404);

    item = yield users.getItem('xyz', { errorIfMissing: false });
    assert.isUndefined(item);
  });

  test('put an item', function *() {
    let item = users.createItem({ firstName: 'Vince', age: 43 });
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
    let err = yield catchError(function *() {
      yield users.deleteItem('ccc');
    });
    assert.isUndefined(err);

    err = yield catchError(function *() {
      yield users.deleteItem('xyz');
    });
    assert.instanceOf(err, Error);
    assert.strictEqual(err.statusCode, 404);

    err = yield catchError(function *() {
      yield users.deleteItem('xyz', { errorIfMissing: false });
    });
    assert.isUndefined(err);
  });

  test('get several items at once', function *() {
    let items = yield users.getItems(['aaa', 'bbb']);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].class.name, 'Superuser');
    assert.strictEqual(items[0].id, 'aaa');
    assert.strictEqual(items[0].firstName, 'Manu');
    assert.strictEqual(items[0].age, 42);
    assert.strictEqual(items[0].superpower, 'telepathy');
    assert.strictEqual(items[1].class.name, 'User');
    assert.strictEqual(items[1].id, 'bbb');
    assert.strictEqual(items[1].firstName, 'Vince');
    assert.strictEqual(items[1].age, 43);
  });

  test('find items', function *() {
    let items = yield users.findItems();
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].class.name, 'Superuser');
    assert.strictEqual(items[0].id, 'aaa');
    assert.strictEqual(items[0].firstName, 'Manu');
    assert.strictEqual(items[0].age, 42);
    assert.strictEqual(items[0].superpower, 'telepathy');
    assert.strictEqual(items[1].class.name, 'User');
    assert.strictEqual(items[1].id, 'bbb');
    assert.strictEqual(items[1].firstName, 'Vince');
    assert.strictEqual(items[1].age, 43);
  });

  test('count items', function *() {
    let count = yield users.countItems();
    assert.strictEqual(count, 2);
  });

  test('find and delete items', function *() {
    let deletedItemsCount = yield users.findAndDeleteItems({
      start: 'bbb', end: 'ddd'
    });
    assert.strictEqual(deletedItemsCount, 3);
  });

  test('call custom method on a collection', function *() {
    let count = yield users.countRetired();
    assert.strictEqual(count, 3);
  });

  test('call custom method on an item', function *() {
    let item = yield users.getItem('aaa');
    let result = yield item.archive();
    assert.isTrue(result.ok);
  });

  test('call custom method with a body', function *() {
    let archive = [{ id: 'aaa', firstName: 'Manu', age: 42 }];
    let result = yield users.restore(archive);
    assert.deepEqual(result, archive);
  });
});
