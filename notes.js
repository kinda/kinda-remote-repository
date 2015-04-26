var repository = RemoteRepository.create('Test', 'http://...', [
  People,
  Images,
  Songs
]);

var peopleCollection = repository.createCollection('People');
