var vatrates = require('vatrates');

module.exports.checkStatus = function( response ) {
	if (response.status >= 200 && response.status < 300) {
		return response;
	}
	else {
		var error = new Error(response.statusText);
		error.response = response;
		throw error;
	}
}

module.exports.parseJson = function( response ) {
	return response.json();
};

module.exports.getCustomerInfo = function( userDoc ) {
	var _roles = userDoc.roles.join(',');

	return {
		customerId: _roles.indexOf('stripe:customer:') !== -1 &&
			_roles.replace(/^.*stripe:customer:(.+?)(,.*)?$/, '$1'),
		countryId: _roles.indexOf('stripe:country:') !== -1 &&
			_roles.replace(/^.*stripe:country:(.+?)(,.*)?$/, '$1'),
		subscriptionId: _roles.indexOf('stripe:subscription:') !== -1 &&
			_roles.replace(/^.*stripe:subscription:(.+?)(,.*)?$/, '$1'),
		planId: _roles.indexOf('stripe:plan:') !== -1 &&
			_roles.replace(/^.*stripe:plan:(.+?)(,.*)?$/, '$1'),
	};
};

module.exports.getVatRate = function( config, customer ) {
	var vendorCountry = config.get('countryCode');
	var vendorRate = config.get('localVatRate');

	if ( !vendorCountry ) {
		throw Boom.expectationFailed('Country code not configured');
	}

	var customerCountry = customer.countryId;

	// when customer is in EU alway use customer country vat rate.
	if ( customerCountry in vatrates ) {
		return vatrates[customerCountry].rates.standard;
	}
	// non-EU customer which is in the same country as
	if ( vendorCountry === customerCountry ) {
		return vendorRate || 0;
	}

	return 0;
};
