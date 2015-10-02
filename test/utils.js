/* eslint-disable no-mixed-requires */
var expect = require('chai').expect;
var utils = require('../lib/utils');
var vatrates = require('vatrates');

describe('utils', function() {
	describe('getCustomerInfo', function() {
		it('should return customer id once it\'s created', function() {
			var customer = utils.getCustomerInfo({
				roles: [
					'stripe:customer:cus_customerId',
				],
			});

			expect(customer.customerId).to.equal('cus_customerId');
		});

		it('should return all customer info once it\'s subscribed', function() {
			var customer = utils.getCustomerInfo({
				roles: [
					'stripe:customer:cus_customerId',
					'stripe:subscription:sub_subscriptionId',
					'stripe:country:AB',
					'stripe:plan:free',
				],
			});

			expect(customer.customerId).to.equal('cus_customerId');
			expect(customer.subscriptionId).to.equal('sub_subscriptionId');
			expect(customer.countryId).to.equal('AB');
			expect(customer.planId).to.equal('free');
		});
	});

	describe('getVatRate', function() {
		it('should be the customer\'s country\'s rate for a EU customer',
			function() {
				var rate = utils.getVatRate({
						get: function(key) {
							return ({
								countryCode: 'UK',
								localVatRate: 15,
							})[key];
						},
					},
					{
						countryId: 'FR',
					}
				);
				expect(rate).to.equal(vatrates.FR.rates.standard);
			});

		it('should be the vendor\'s country rate for customer in same country',
			function() {
				var rate = utils.getVatRate({
						get: function(key) {
							return ({
								countryCode: 'ME',
								localVatRate: 16,
							})[key];
						},
					},
					{
						countryId: 'ME',
					}
				);
				expect(rate).to.equal(16);
			});

		it('should be 0 when customer is non-EU and vendor of other country',
			function() {
				var rate = utils.getVatRate({
						get: function(key) {
							return ({
								countryCode: 'PO',
								localVatRate: 23,
							})[key];
						},
					},
					{
						countryId: 'US',
					}
				);
				expect(rate).to.equal(0);
			});
	});
});
