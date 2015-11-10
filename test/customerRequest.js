if ( typeof require !== 'undefined' ) {
	var expect = require('chai').expect;
	var customerRequest = require('../hooks/handlers/customerRequest');
	var hoodie = require('./setup-hoodie')();
	var fetch = require('node-fetch');
	var Promise = require('bluebird');
	var Stripe = require('stripe');

	var HOODIE_URL = process.env.HOODIE_URL;

	var stripeTokensCreate = function( card, callback ) {
		if ( !process.env.STRIPE_KEY ) {
			throw new Error('STRIPE_KEY env variable required');
		}

		var stripe = Stripe(process.env.STRIPE_KEY);

		stripe.tokens.create({
			card: card,
		}, callback );
	};
}

/* eslint-disable no-console */
function randomSignUpIn() {
	var username = 'u' + Math.round( Math.random() * 1E9 );
	var password = 'p' + Math.round( Math.random() * 1E9 );
	var hoodieId = Math.random().toString().substr(2);
	var userUrl = 'org.couchdb.user:user/' + username;

	return (fetch || window._fetch)(
		HOODIE_URL + '/_api/_users/' + encodeURIComponent(userUrl),
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
	// we need to wait a bit before the user is confirmed
	// automatically by Hoodie
	.then(function() {
		return new Promise(function(resolve) {
			setTimeout(function() {
				hoodie.account.signIn( username, password );
				resolve();
			}, 300);
		});
	});
}

describe('customerRequest', function() {
	it('should reply an error when no Stripe key is configured', function() {
		var reply;
		customerRequest({
				config: { get: function() {} },
			}, {
				raw: { res: {} },
			}, function(r) {
				reply = r;
			});

		expect(reply).to.be.an.instanceOf(Error);
	});

	it('should reply an error when user isn\'t logged in', function(done) {
		hoodie.stripe.customers.create()
			.catch(function(error) {
				expect(error.statusCode).to.equal(401);
				done();
			});
	});

	describe('create and update stripe paid subscription', function() {
		var token;

		before(function(done) {
			randomSignUpIn()
				.then(function() {
					done();
				})
				.catch(function( error ) {
					console.log(error);
				});
			});

		before(function(done) {
			stripeTokensCreate({
				'number': '4012888888881881',
				'exp_month': '12',
				'exp_year': '2017',
				'cvc': '272',
				'name': 'ME MYSLEF AND I',
			}, function(err, _token) {
				token = _token;
				done();
			});
		});

		it('should relay a meaningful Stripe error', function(done) {
			hoodie.stripe.customers.create({
					'plan': 'hoodie_test1_USD_taxfree',
				})
				.fail(function(error) {
					expect(error.statusCode).to.equal(400);
					expect(error.message).to.equal(
						'This customer has no attached payment source');
					done();
				});
		});

		it('should relay a meaningful Taxamo error', function(done) {
			this.timeout(2000);

			hoodie.stripe.customers.create({
					'plan': 'hoodie_test1_USD_taxfree',
					'source': token.id,
					'buyer_credit_card_prefix': 'zob',
				})
				.fail(function(error) {console.log(error);
					expect(error.statusCode).to.equal(400);
					expect(error.message).to.equal('Bad Request');
					done();
				});
		});

		it('can create a customer and subscribe to a paid plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.create({
					'source': token.id,
					'plan': 'hoodie_test1_USD_taxfree',
					'buyer_tax_number': undefined,
					'buyer_credit_card_prefix': '424242424',
					'currency_code': 'USD',
				})
				.then(function(body) {
					expect(body.plan).to.equal('hoodie_test1_USD_taxfree');
					done();
				})
				.catch(function( error ) {
					console.log(error);
				});
			}
		);

		it('can update a customer and subscribe to another paid plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.updateSubscription({
						plan: 'hoodie_test2_USD_taxfree',
					})
					.then(function(body) {
						expect(body.plan).to.equal('hoodie_test2_USD_taxfree');
						done();
					})
					.catch(function( error ) {
						console.log(error);
					});
			}
		);

		it('stores information about the plan the user is subscribed to',
			function(done) {
				this.timeout(3000);

				hoodie.request('get', '/_session')
					.then(function(body) {
						expect(body.userCtx.roles)
							.include('stripe:plan:hoodie_test2_USD_taxfree');
						done();
					})
					.catch(function( error ) {
						console.log(error);
					});
			}
		);

		it('can retrieve the Stripe user that was created',
			function(done) {
				this.timeout(3000);

				hoodie.stripe.customers.retrieve()
					.then(function(customer) {console.log(customer);
						// expect(body.userCtx.roles)
						// 	.include('stripe:plan:hoodie_test2_USD_taxfree');
						done();
					})
					.catch(function( error ) {
						console.log(error);
					});
			}
		);

		// TODO: for some reason signOut fails when tests are run from
		// the command line so you can test only this describe block or
		// the following.
		after(function(done) {
			hoodie.account.signOut()
				.then(function() {
					setTimeout(function() {
						done();
					}, 1000);
				});
		});
	});

	describe('create and update stripe free subscription', function() {
		var token;

		before(function(done) {
			randomSignUpIn()
				.then(function() {
					done();
				})
				.catch(function( error ) {
					console.log(error);
				});
			});

		before(function(done) {
			stripeTokensCreate({
				'number': '4242424242424242',
				'exp_month': '12',
				'exp_year': '2017',
				'cvc': '272',
				'name': 'ME MYSLEF AND I',
			}, function(err, _token) {
				token = _token;
				done();
			});
		});

		it('can create a customer and subscribe to a free plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.create({})
				.then(function(body) {
					expect(body.plan).to.equal('free_none');
					done();
				})
				.catch(function( error ) {
					console.log(error);
				});
			}
		);

		it('can update a customer and upgrade to a paid plan',
			function(done) {
				this.timeout(5000);

				hoodie.stripe.customers.updateSubscription({
						source: token.id,
						plan: 'hoodie_test2_USD_taxfree',
						'buyer_tax_number': undefined,
						'buyer_credit_card_prefix': '424242424',
						'currency_code': 'USD',
					})
					.then(function(body) {
						expect(body.plan).to.equal('hoodie_test2_USD_taxfree');
						done();
					})
					.catch(function( error ) {
						console.log(error);
					});
			}
		);

		it('stores information about the plan the user is subscribed to',
			function(done) {
				this.timeout(3000);

				hoodie.request('get', '/_session')
					.then(function(body) {
						expect(body.userCtx.roles)
							.include('stripe:plan:hoodie_test2_USD_taxfree');
						done();
					})
					.catch(function( error ) {
						console.log(error);
					});
			}
		);

		after(function() {
			hoodie.account.signOut();
		});
	});
});
