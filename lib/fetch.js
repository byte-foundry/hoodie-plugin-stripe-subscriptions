var Boom = require('boom');

var fetch = {};

// parseJson always happens first after a fetch, and only checks Content-Type.
// In many cases the response.status can be an error but useful body has
// been sent.
fetch.parseJson = function( response ) {
	if ( response.headers.get('Content-Type').indexOf('json') !== -1 ) {
		return response.json()
			.then(function( body ) {
				return {
					response: response,
					body: body,
				};
			});
	}

	var error = new Error(
			response.ok ? 'Unexpected Content-Type' : response.statusText );
	error.response = response;
	throw error;
};

fetch.checkStatus = function( args ) {
	var response = args.response;
	var body = args.body;

	if ( response.ok ) {
		return body;
	}

	throw Boom.create( response.status, response.statusText, body );
};

module.exports = fetch;
