var Boom = require('boom');
var _ = require('lodash');
var utils = require('./fetch');
var fetch = require('node-fetch');

var taxamo = {};

taxamo.transactionCreateOrUpdateOrNot = function( context ) {
	var userDoc = context.userDoc;
	var card  = context.token && context.token.card;
	var config = context.hoodie.config;
	var isUpdate = context.userDoc.taxamo && context.userDoc.taxamo.key;

	var createWhitelist = [
		'buyer_credit_card_prefix',
		'buyer_name',
		'buyer_email',
		'buyer_tax_number',
		'invoice_address',
		'transaction_lines',
		'currency_code',
		'description',
		'status',
		'force_country_code',
	];
	var updateWhitelist = [
		'buyer_name',
		'buyer_tax_number',
		'invoice_address',
	];

	var transaction = _.assign({
			'transaction_lines': [
				{
					'custom_id': 'dontRemoveThisProp',
					'amount': 0,
				},
			],
			// the currency code of the placeholder transaction is irrelevant
			'currency_code': 'USD',
			'description': 'Subscription',
			'status': 'C',
			'force_country_code': card && card.country,
		},
		context.args[0]
	);

	// accept only whitlisted properties
	transaction = _.pick(transaction, function( value, key ) {
		return _.includes(
			isUpdate ? updateWhitelist : createWhitelist,
			key
		);
	});

	// Do we need a transaction?
	if (
		!config.get('taxamoKey') ||
		!(
			( card ) ||
			( context.args[0] && context.args[0]['invoice_address'] )
		)
	) {
		return;
	}

	if ( !isUpdate ) {
		// the userDoc.id might be the user's email
		if ( !transaction['buyer_email'] && /^[\S]+@[\S]+$/.test(userDoc.id) ) {
			transaction['buyer_email'] = userDoc.id;
		}

		if (
			config.get('universalPricing')
		) {
			// universal pricing (only applies to B2C transactions)
			// TODO: not sure if it makes sense to only use it for B2C
			delete transaction['transaction_lines'][0].amount;
			transaction['transaction_lines'][0]['total_amount'] = 0;
		}

		if ( context.token && context.token['client_ip'] ) {
			transaction['buyer_ip'] = context.token['client_ip'];
		}
	}

	// when a test key is used, some properties can be forced
	if ( /^sk_test_/.test( config.get('stripeKey') ) ) {
		if ( context.args[0]['tax_deducted'] ) {
			transaction['tax_deducted'] = context.args[0]['tax_deducted'];
		}

		if ( context.args[0]['force_country_code'] ) {
			transaction['force_country_code'] =
				context.args[0]['force_country_code'];
		}
	}

	var headers = {
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'Private-Token': config.get('taxamoKey'),
	};

	var body = { transaction: transaction };
	var url =
		'https://api.taxamo.com/api/v1/transactions/' +
		( isUpdate ? userDoc.taxamo.key : '' );

	return fetch(url, {
			method: isUpdate ? 'put' : 'post',
			headers: headers,
			body: JSON.stringify(body),
			timeout: 3000,
		})
		.then(utils.parseJson)
		.then(utils.checkStatus)
		.then(function( transaction ) {
			transaction = transaction.transaction;
			// There's a special option to only accept plans priced
			// in euro for EU customers.
			if (
				!isUpdate &&
				config.get('euroInEU') &&
				transaction['tax_region'] === 'EU' &&
				context.args[0]['currency_code'] !== 'EUR'
			) {
				throw Boom.forbidden(
					'European customers must choose a plan in euro.'
				);
			}

			context.userNeedsUpdate = true;
			userDoc.taxamo = {
				'key': transaction.key,
				'buyer_tax_number': transaction['buyer_tax_number'],
				'tax_rate': transaction['transaction_lines'][0]['tax_rate'],
				'tax_region': transaction['tax_region'],
				'tax_country_code': transaction['tax_country_code'],
				'tax_deducted': transaction['tax_deducted'],
				'billing_country_code': transaction['billing_country_code'],
			};
			context.taxamo = transaction;

			return transaction;
		});
};

module.exports = taxamo;
