var util = require('util');
var uuid = require('node-uuid');
var Boom = require('boom');
var fetch = require('./fetch');
var hoodie = require('./hoodie');
var stripe = require('./stripe');
var taxamo = require('./taxamo');
var vatrates = require('vatrates');

var utils = {
	fetch: fetch,
	hoodie: hoodie,
	stripe: stripe,
	taxamo: taxamo,
};

utils.checkCurrency = function( context ) {
	// There's a special option to only accept plans priced
	// in euro for EU customers.
	if (
		context.hoodie.config.get('euroInEU') &&
		context.userDoc.taxamo &&
		context.userDoc.taxamo['tax_region'] === 'EU' &&
		context.args[0] &&
		context.args[0]['currency_code'] &&
		context.args[0]['currency_code'] !== 'EUR'
	) {
		throw Boom.forbidden(
			'European customers must pay in euro.'
		);
	}
}

utils.checkCurrencyAlt = function( context ) {
	// There's a special option to only accept plans priced
	// in euro for EU customers.
	if (
		context.hoodie.config.get('euroInEU') &&
		context.token &&
		( context.token.card.country in vatrates ) &&
		context.args[0] &&
		context.args[0]['currency_code'] &&
		context.args[0]['currency_code'] !== 'EUR'
	) {
		throw Boom.forbidden(
			'European customers must pay in euro.'
		);
	}
}

utils.replyError = function( hoodie, context, error ) {
	// Boomify Stripe errors
	if ( error.type && /^Stripe/.test(error.type) ) {
		error = Boom[ /^StripeInvalidReq/.test(error.type) ?
				'badRequest' :
				'badImplementation'
			]( error.message, error );
	}

	// include error details in the payload
	if ( error.isBoom ) {
		if ( error.data ) {
			error.output.payload.details = error.data;
		}
		// Hoodie uses error.reason as the message :-/
		error.output.payload.reason = error.message;
	}

	// log error to the client (if the option is active)
	context.log( error.message, error.stack );
	// log error on the server
	hoodie.database('plugin/stripe').add('error', {
		id: uuid.v4(),
		message: error.message,
		details: util.inspect(error.data),
		stack: error.stack,
		payload: util.inspect(context.request.payload),
		headers: util.inspect(context.request.headers),
		email: context.userDoc && context.userDoc.id,
	}, function() {});
	return context.reply( error );
};

module.exports = utils;
