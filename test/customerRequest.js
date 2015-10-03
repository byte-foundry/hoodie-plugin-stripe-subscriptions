var expect = require('chai').expect;
var customerRequest = require('../hooks/handlers/customerRequest');
var hoodie = require('./setup-hoodie')();
var fetch = require('node-fetch');
var Promise = require('bluebird');
// var util = require('util');

function randomSignup() {
	var username = 'u' + Math.round( Math.random() * 1E9 );
	var password = 'p' + Math.round( Math.random() * 1E9 );
	var hoodieId = Math.random().toString().substr(2);
	var userUrl = 'org.couchdb.user:user/' + username;

	return fetch(
		process.env.HOODIE_URL + '/_api/_users/' + encodeURIComponent(userUrl),
		{
			method: 'put',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
			body: JSON.stringify({
				_id: userUrl,
				name: 'user/' + username,
				type: 'user',
				roles: [],
				password: password,
				hoodieId: hoodieId,
				database: 'user/' + hoodieId,
				updatedAt: new Date(),
				createdAt: new Date(),
				signedUpAt: new Date(),
			}),
		}
	)
	.then(function() {
		return {
			name: username,
			password: password,
		};
	});
}

describe('customerRequest', function() {
	it('should reply an error when no Stripe key is configured', function() {
		var reply;
		customerRequest({ config: { get: function() {} } }, {}, function(r) {
			reply = r;
		});

		expect(reply).to.be.an.instanceOf(Error);
	});

	it('should reply an error when user isn\'t authenticated', function(done) {
		hoodie.stripe.customers.create()
			.catch(function(error) {
				expect(error.statusCode).to.equal(401);
				done();
			});
	});

	describe('create and update stripe subscription', function() {
		before(function(done) {
			randomSignup()
				// we need to wait a bit before the user is confirmed
				// automatically by Hoodie
				.then(function(_credentials) {
					var deferred = Promise.pending();

					global.setTimeout(function() {
						deferred.resolve(_credentials);
					}, 300);

					return deferred.promise;
				})
				.then(function(_credentials) {
					return hoodie.account
							.signIn(_credentials.name, _credentials.password);
				})
				.then(function() {
					done();
				});
			});

		it('can create a customer and subscribe to the free plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.create({
					source: {
						'object': 'card',
						'number': '4242424242424242',
						'exp_month': '12',
						'exp_year': '2017',
						'cvc': '272',
						'name': 'ME MYSLEF AND I',
					},
					taxNumber: undefined,
					cardPrefix: '424242424',
					currencyCode: 'USD',
					plan: 'b2c_monthly_launch',
				})
				.then(function(body) {
					expect(body.plan).to.equal('b2c_monthly_launch');
					done();
				});
			}
		);

		it('can update a customer and subscribe to the free plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.updateSubscription({
						plan: 'b2c_yearly_launch',
					})
					.then(function(body) {
						expect(body.plan).to.equal('b2c_yearly_launch');
						done();
					});
			}
		);

		it('stores information about the plan the user is subscribed to',
			function(done) {
				hoodie.request('get', '/_session')
					.then(function(body) {
						expect(body.userCtx.roles)
							.include('stripe:plan:b2c_yearly_launch');
						done();
					});
			}
		);
	});
});
