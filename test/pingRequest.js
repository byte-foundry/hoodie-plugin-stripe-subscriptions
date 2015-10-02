var expect = require('chai').expect;
var hoodie = require('./setup-hoodie')();

describe('pingRequest', function() {
	it('should be able to ping the plugin api', function(done) {
		hoodie.stripe.ping()
			.then(function(data) {
				expect(data).to.deep.equal({ pong: true });
				done();
			});
	});

	it('should be able to retrieve the data sent', function(done) {
		hoodie.stripe.ping({
				hello: 'world',
			})
			.then(function(data) {
				expect(data).to.deep.equal({ hello: 'world' });
				done();
			});
	});
});
