var expect = require('chai').expect;
var worker = require('../worker.js');
var Stripe = require('stripe');

describe('worker.js', function() {
	describe('fetchAllStripePlans', function() {
		it('should return more than one plan', function(done) {
			if ( !process.env.STRIPE_KEY ) {
				throw new Error('STRIPE_KEY env variable required');
			}

			stripe = Stripe(process.env.STRIPE_KEY);

			worker.fetchAllStripePlans( stripe, { limit: 1 } )
				.then(function(allStripePlans) {
					expect(Object.keys(allStripePlans).length)
						.to.be.above(1);
					done();
				});
		});
	});
});
