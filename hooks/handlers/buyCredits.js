var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

module.exports = function buyCreditsHandler( context ) {
	return Promise.all([
			Promise.resolve()
				.then(_.partial(utils.hoodie.fetchSession, context ))
				.then(_.partial(utils.hoodie.accountFind, context )),
			Promise.resolve()
				.then(_.partial(utils.stripe.tokensRetrieveOrNot, context))
				.then(_.partial(utils.checkCurrencyAlt, context))
		])
		.then(function() {
			if ( context.userDoc.stripe && context.userDoc.stripe.customerId ) {
				return utils.stripe.customersRetrieveOrNot( context );
			}
			else {
				return utils.stripe.customersCreateOrNot( context )
					.then(_.partial(utils.hoodie.accountUpdateOrNot, context ));
			}
		})
		.then(_.partial(utils.stripe.orderCreateOrNot, context))
		.then(_.partial(utils.stripe.orderPayOrNot, context ))
		.then(function() {
			// the number of credits to add is read from the first part of the
			// sku's id
			context.credits =
				parseInt( context.order.items[0].parent, 10 ) +
				parseInt( (context.customer.metadata.credits || 0), 10);
		})
		.then(_.partial(utils.stripe.customerCreditsUpdateOrNot, context))
		.then(function() {
			_.assign( context.customer, {
				credits: context.credits || 0,
				authorization: context.request.headers.authorization,
			});
			context.reply( null, context.customer );
		});
};
