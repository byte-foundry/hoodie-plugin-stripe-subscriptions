var _ = require('lodash');
// var Boom = require('boom');

var stripe = {};

stripe.customersCreateOrNot = function( context ) {
	if ( context.userDoc.stripe && context.userDoc.stripe.customerId ) {
		return;
	}

	var params = {
		description: 'Customer for ' + context.userDoc.name.split('/')[1],
		metadata: { 'hoodieId': context.userDoc.id },
	};

	if ( /^[\S]+@[\S]+$/.test( context.userDoc.id ) ) {
		params.email = context.userDoc.id;
	}

	return context.stripe.customers.create( params )
		.then(function( customer ) {
			context.userNeedsUpdate = true;
			context.customer = customer;

			if ( !context.userDoc.stripe ) {
				context.userDoc.stripe = {};
			}

			context.userDoc.stripe.customerId = customer.id;
			context.userDoc.stripe.plan = 'free_none';
		});
};

stripe.customersRetrieveOrNot = function( context ) {
	if ( context.customer ) {
		return;
	}

	return context.stripe.customers.retrieve(
			context.userDoc.stripe.customerId
		)
		.then(function( customer ) {
			context.customer = customer;
		});
};

stripe.chargesListOrNot = function( context ) {
	if (
		!context.customer ||
		!context.args ||
		!context.args[0] ||
		context.args[0].includeCharges !== true
	) {
		return;
	}

	return context.stripe.charges.list({
			customer: context.customer.id,
			limit: 12,
		})
		.then(function( charges ) {
			context.customer.charges = charges;
		});
};

stripe.invoicesRetrieveUpcoming = function( context ) {
	var customer = context.userDoc.stripe;
	var whitelist = [
			'subscription_plan',
			'subscription_quantity',
			'subscription_trial_end',
		];
	// mix following object with whitelisted properties from requestData
	var params = _.assign({
			'subscription_prorate': true,
		},
		_.pick(context.args[0], function( value, key ) {
			return _.includes( whitelist, key );
		}));

	return context.stripe.invoices.retrieveUpcoming.apply(
			context.stripe.invoices,
			customer.subscriptionId ? [
				customer.customerId,
				customer.subscriptionId,
				params,
			] : [
				customer.customerId,
				params,
			]
		);
};

stripe.tokensRetrieveOrNot = function( context ) {
	var source = context.args && context.args[0] && context.args[0].source;

	if ( !source ) {
		return;
	}

	return context.stripe.tokens.retrieve( source )
		.then(function( token ) {
			context.token = token;
		});
};

stripe.customersCreateOrUpdateOrNot = function( context ) {
	var userDoc = context.userDoc;
	var taxamo = context.userDoc.taxamo;
	var config = context.hoodie.config;
	var isUpdate = context.userDoc.stripe && context.userDoc.stripe.customerId;

	context.customer = {};

	var createWhitelist = [
			'source',
			'coupon',
			'quantity',
			'email',
			'plan',
		];
	var updateWhitelist = [
			'source',
			'coupon',
			'quantity',
			'email',
		];

	// mix following object with whitelisted properties from requestData
	var params = _.pick(context.args[0], function( value, key ) {
		return _.includes(
			isUpdate ? updateWhitelist : createWhitelist,
			key
		);
	});

	if ( !isUpdate ) {
		params.description = 'Customer for ' + userDoc.name.split('/')[1];
		params.metadata = { 'hoodieId': userDoc.id };
	}

	if ( context.taxamo ) {
		params.metadata = {
			'hoodieId': userDoc.id,
			'taxamo_transaction_key': context.taxamo.key,
		};
	}

	if ( Object.keys( params ).length === 0 ) {
		return;
	}

	// the userDoc.id might be the user's email
	if ( !isUpdate && !params.email && /^[\S]+@[\S]+$/.test(userDoc.id) ) {
		params.email = userDoc.id;
	}

	// TODO: there should be a way to configure the tax-rate globally
	if ( params.plan ) {
		params['tax_percent'] = !taxamo || config.get('universalPricing') ?
			0 :
			taxamo['tax_rate'];
	}

	return context.stripe.customers[ isUpdate ? 'update' : 'create' ].apply(
			context.stripe.customers,
			isUpdate ? [
				userDoc.stripe.customerId,
				params,
			] : [
				params,
			]
		)
		.then(function(body) {
			context.userNeedsUpdate = true;
			context.customer = body;

			if ( !userDoc.stripe ) {
				userDoc.stripe = {};
			}

			userDoc.stripe.customerId = body.id;
			userDoc.stripe.plan = 'free_none';
			if (
				body.subscriptions &&
				body.subscriptions.data &&
				body.subscriptions.data.length
			) {
				userDoc.stripe.subscriptionId = body.subscriptions.data[0].id;
				userDoc.stripe.plan = body.subscriptions.data[0].plan.id;
			}
		});
};

stripe.customersCreateOrUpdateOrNotSubscription = function( context ) {
	var customer = context.userDoc.stripe;
	var taxamo = context.userDoc.taxamo;
	var config = context.hoodie.config;

	var params = { plan: context.args[0].plan };

	// TODO: there should be a way to configure the tax-rate globally
	if ( params.plan ) {
		params['tax_percent'] = !taxamo || config.get('universalPricing') ?
			0 :
			taxamo['tax_rate'];
	}

	var method;
	if ( !params.plan && context.method === 'customers.updateSubscription' ) {
		method = 'cancel' + 'Subscription';
	}
	else if (
		params.plan &&
		customer.subscriptionId &&
		params.plan != context.userDoc.stripe.plan
	) {
		method = 'update' + 'Subscription';
	}
	else if ( params.plan && !customer.subscriptionId ) {
		method = 'create' + 'Subscription';
	}
	else {
		return;
	}

	return context.stripe.customers[ method ].apply(
			context.stripe.customers,
			method === 'createSubscription' ? [
				customer.customerId,
				params,
			] : method === 'updateSubscription' ? [
				customer.customerId,
				customer.subscriptionId,
				params,
			] : [
				customer.customerId,
			]
		)
		.then(function( body ) {
			context.userNeedsUpdate = true;

			customer.subscriptionId = body.status === 'canceled' ?
				undefined :
				body.id;
			customer.plan = body.status === 'canceled' ?
				'free_none' :
				body.plan.id;
		});
};

stripe.orderCreateOrNot = function( context ) {
	if ( !context.args[0]['items'] ) {
		return;
	}

	var customer = context.userDoc.stripe;
	var whitelist = [
		'source',
		'coupon',
	];
	var defaults = {
		currency: context.args[0]['currency_code'],
		customer: customer.customerId,
		items: context.args[0]['items']
	};

	// mix following object with whitelisted properties from requestData
	var params = _.pick(context.args[0], function( value, key ) {
		return _.includes(whitelist, key);
	});

	params = Object.assign(params, defaults);

	return context.stripe.orders.create(params)
		.then(function(order) {
			context.order = order;
		});
};

stripe.orderPayOrNot = function( context ) {
	if ( !context.order ) {
		return;
	}

	return context.stripe.orders.pay(
			context.order.id,
			context.source ? context.source : undefined
		)
		.then(function(order) {
			context.order = order;
		});
};

stripe.customerCreditsUpdateOrNot = function( context ) {
	if ( !('credits' in context) ) {
		return;
	}

	context.stripe.customers.update(context.customer, {
		metadata: { credits: context.credits }
	});
}

module.exports = stripe;
