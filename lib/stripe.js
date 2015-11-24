var _ = require('lodash');

var stripe = {};

stripe.customersCreateOrNot = function( context ) {
	if ( context.userDoc.stripe && context.userDoc.stripe.customerId ) {
		return;
	}

	if ( !context.userDoc.stripe ) {
		context.userDoc.stripe = {};
	}

	return context.stripe.customers.create( { email: context.userName } )
		.then(function( customer ) {
			context.userNeedsUpdate = true;
			context.customer = customer;

			context.userDoc.stripe.customerId = customer.id;
			context.userDoc.stripe.plan = '';
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
			userDoc.stripe && userDoc.stripe.customerId ?
				updateWhitelist :
				createWhitelist,
			key
		);
	});

	if ( !isUpdate ) {
		params.description = 'Customer for ' + userDoc.name.split('/')[1];
		params.metadata = { 'hoodieId': userDoc.id };
	}

	if ( context.taxamo ) {
		params.metadata = { 'taxamo_transaction_key': context.taxamo.key };
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

	if ( !(
			// a plan has been sent
			context.args[0] && context.args[0].plan !== undefined &&
			// and it's not the current plan
			// Note: non-strict equality is justified here, as the requested
			// plan might be null, which is equivalent to the current plan
			// being undefined
			context.args[0].plan != context.userDoc.stripe.plan
	)) {
		return;
	}

	var params = { plan: context.args[0].plan };

	// TODO: there should be a way to configure the tax-rate globally
	if ( params.plan ) {
		params['tax_percent'] = !taxamo || config.get('universalPricing') ?
			0 :
			taxamo['tax_rate'];
	}

	var method = (
		customer.subscriptionId ?
			( context.args[0].plan ? 'update' : 'cancel' ) :
			'create'
	) + 'Subscription';

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

module.exports = stripe;
