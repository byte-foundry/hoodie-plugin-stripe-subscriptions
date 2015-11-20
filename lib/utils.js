var Boom = require('boom');
var fetch = require('./fetch');
var hoodie = require('./hoodie');
var stripe = require('./stripe');
var taxamo = require('./taxamo');

var utils = {
	fetch: fetch,
	hoodie: hoodie,
	stripe: stripe,
	taxamo: taxamo,
};

utils.replyError = function( context, error ) {
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

	context.log( error.message, error.stack );
	return context.reply( error );
};

module.exports = utils;
