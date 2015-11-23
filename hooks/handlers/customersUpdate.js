var Promise = require('bluebird');
var utils = require('../../lib/utils');
var _ = require('lodash');

// Possibilités pour l'utilisateur :
// - spécifier son adresse
// - spécifier son numéro de tva
// - spécifier son plan
// - spécifier sa carte de crédit
// - spécifier un tax_percent
// - spécifier un coupon
// - spécifier une quantité
// - spécifier son email ?
//   -> NON (pour l'instant on considère que l'email ne peut pas être changé)

// Je dois create le customer quand il n'existe pas et que :
// - un plan est spécifié
// - une carte de crédit est spécifiée
// - un coupon est spécifié
// - une quantité est spécifiée
// - une adresse est spécifiée
//   -> NON, l'adresse ne se met pas à jour sur le customer
// - un tax_percent est spécifié
//   -> NON, pas pour l'instant
// - un numéro de TVA est spécifié
//   -> NON, c'est le problème de Taxamo

// Je dois update le customer Stripe quand :
// - une carte de crédit est spécifiée
// - un coupon est spécifié
// - une quantité est spécifiée
// - une adresse est spécifiée
//   -> NON, l'adresse ne se met pas à jour sur le customer
// - un plan est spécifié ?
//   -> NON, on utilise stripe.customers.xxxSubscription
// - un tax_percent est spécifié
//   -> NON, pas pour l'instant
// - un numéro de TVA est spécifié
//   -> NON, c'est le problème de Taxamo

// Je dois update/create/delete une subscription quand le customer existe et :
// - le plan est spécifié

// Je dois create une transaction Taxamo quand elle n'existe pas et :
// - une source est spécifiée
// - une adresse est spécifiée
// - une adresse est présente pour le customer ?
//   -> NON, on se fait pas chier, on le fait que quand elle est spécifiée
// - une source est présente pour le customer ?
//   -> NON, on a accès aux infos intéressante que quand on reçoit la source

// Je dois update une transaction Taxamo quand elle existe et :
// - une source est spécifiée
// - une adresse est spécifiée

module.exports = function customersUpdateHandler( context ) {
	return Promise.all([
			Promise.resolve()
				.then(_.partial(utils.hoodie.fetchSession, context ))
				.then(_.partial(utils.hoodie.accountFind, context )),
			Promise.resolve()
				.then(_.partial(utils.stripe.tokensRetrieveOrNot, context)),
		])
		// we need to wait for account.find to choose between create/update
		.then(_.partial(utils.taxamo.transactionCreateOrUpdateOrNot, context))
		.then(_.partial(utils.stripe.customersCreateOrUpdateOrNot, context))
		.then(_.partial(utils.stripe.customersCreateOrUpdateOrNotSubscription,
			context))
		.then(_.partial(utils.hoodie.accountUpdateOrNot, context ))
		.then(function() {
			_.assign( context.customer, {
				plan: context.userDoc.stripe && context.userDoc.stripe.plan,
				authorization: context.request.headers.authorization,
			});
			context.reply( null, context.customer );
		})
		.catch(_.partial(utils.replyError, context));
};
