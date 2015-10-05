var expect = require('chai').expect;
var utils = require('../lib/utils');
var Stripe = require('stripe');

describe('utils.js', function() {
	describe('fetchAllStripePlans', function() {
		it('should return more than one plan', function(done) {
			this.timeout(3000);

			if ( !process.env.STRIPE_KEY ) {
				throw new Error('STRIPE_KEY env variable required');
			}

			stripe = Stripe(process.env.STRIPE_KEY);

			utils.fetchAllStripePlans( stripe, { limit: 1 } )
				.then(function(allStripePlans) {
					expect(Object.keys(allStripePlans).length)
						.to.be.above(1);
					done();
				});
		});
	});
});
