$(function() {

	var hoodieAdmin = top.hoodieAdmin;

	function getConfig(callback) {
	  hoodieAdmin.request('GET', '/app/config')
		.fail(function(error) { callback(error); })
		.done(function(response) { callback(null, response); })
	}
	function setConfig(doc, callback) {
	  hoodieAdmin.request('PUT', '/app/config', {
		data: JSON.stringify(doc),
	  })
		.fail(function(error) { callback(error); })
		.done(function(response) { callback(null, response); })
	}

	function updateConfig(obj, callback) {
		getConfig(function(err, doc) {
			if (err) {
				return callback(err);
			}
			doc.config = _.extend(doc.config, obj);
			setConfig(doc, callback);
		});
	}

	// set initial form values
	getConfig(function(err, doc) {
		if (err) {
			return alert(err);
		}
		$('[name=stripeKey]').val(doc.config.stripeKey);

		$('[name=taxamoKey]').val(doc.config.taxamoKey);
		$('[name=euroInEU]').prop('checked', doc.config.euroInEU)
			.iCheck('update');
		$('[name=universalPricing]').prop('checked', doc.config.universalPricing)
			.iCheck('update');

		$('[name=stripeDebug]').prop('checked', doc.config.stripeDebug)
			.iCheck('update');
	});

	function setSubmitButtonToSaving(form) {
		$btn = $(form).find('button[type="submit"]');
		$btn.data('originalButtonText', $btn.text());
		$btn.data('disabled', 'disabled');
		$btn.text('Saving');
	}

	function setSubmitButtonToSuccess(form) {
		$btn.text('Successfully saved!').addClass('success');
		_.delay(function() {
			$(form).find('button[type="submit"]').data('disabled', null);
			$btn.text($btn.data('originalButtonText')).removeClass('success');
		}, 2000);
	}

	function setSubmitButtonToError(form, error) {
		$btn.text('Something went wrong, sorry.').addClass('error');
		$btn.after('<p class="help-block">' + error + '</p>');
		_.delay(function() {
			$(form).find('button[type="submit"]').data('disabled', null);
			$btn.text($btn.data('originalButtonText')).removeClass('error');
		}, 2000);
	}

	// save stripe settings on submit
	$('#stripeConfig').submit(function(ev) {
		var el = this;
		ev.preventDefault();
		setSubmitButtonToSaving(this);
		var cfg = {
			stripeKey: $.trim( $('[name=stripeKey]').val() ),
		};
		updateConfig(cfg, function(err) {
			if (err) {
				setSubmitButtonToError(el, err);
			}
			else {
				setSubmitButtonToSuccess(el);
			}
		});
		return false;
	});

	$('#taxamoConfig').submit(function(ev) {
		var el = this;
		ev.preventDefault();
		setSubmitButtonToSaving(this);

		if ( !$.trim( $('[name=taxamoKey]').val() ) ) {
			return setSubmitButtonToError(el, 'Taxamo key is required.');
		}

		var cfg = {
			taxamoKey: $.trim( $('[name=taxamoKey]').val() ),
			euroInEU: $('[name=euroInEU]').prop('checked'),
			universalPricing: $('[name=universalPricing]').prop('checked'),
		};
		updateConfig(cfg, function(err) {
			if (err) {
				setSubmitButtonToError(el, err);
			}
			else {
				setSubmitButtonToSuccess(el);
			}
		});
		return false;
	});

	$('#miscConfig').submit(function(ev) {
		var el = this;
		ev.preventDefault();
		setSubmitButtonToSaving(this);
		var cfg = {
			stripeDebug: $('[name=stripeDebug]').prop('checked'),
		};
		updateConfig(cfg, function(err) {
			if (err) {
				setSubmitButtonToError(el, err);
			}
			else {
				setSubmitButtonToSuccess(el);
			}
		});
		return false;
	});
});
