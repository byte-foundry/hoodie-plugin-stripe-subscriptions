# hoodie-plugin-stripe-subscriptions

Basic Stripe subscriptions for Hoodie. This plugin also integrates [Taxamo](taxamo.com)
to handle taxes (notably VAT in EU).

## Installing

Please refer to Hoodie documentation on how to [install the plugin](http://docs.hood.ie/en/plugins/index.html).

## Configuring

After installing the plugin, it must be configured using your Stripe key.

You can, and probably should, let Taxamo handle tax calculation for you.
See [Handling Taxes](#handling-taxes) section below.

## Using

This plugins adds a `.stripe.customers` property to the client-side `hoodie`
library, with several methods taken from Stripe's server-side API.

### `hoodie.stripe.customers.create`

```js
hoodie.stripe.customers.create({
		// token obtained with Stripe.js, optional for free plans
		source: 'tok_16sgLrEHNnZkutNMqnfDXXXX',
		plan: 'stripe_plan_id'
	});
```
Required Stripe properties: None, although it's recommended to always specify a
`plan`, and when this plan isn't free, a `source` is required as well.

Accepted Stripe properties: `source`, `plan`, `coupon`.

See [Stripe documentation](https://stripe.com/docs/api#create_customer)
for details on this method and its properties.

When a source is specified, if Taxamo is enabled, the following properties
are required: `currency_code`, `buyer_credit_card_prefix`.
And the following properties are accepted `buyer_email`, `buyer_tax_number`.

See [Taxamo documentation](https://www.taxamo.com/apidocs/api/v1/transactions/docs.html#POST)
for details on transaction properties.

When this method succeed, the specified plan will appear in the user document
as the `stripe.plan` attribute, and in the user's roles, e.g.
`stripe:plan:<plan name>`.
See [Hoodie documentation](http://docs.hood.ie/en/techdocs/api/client/hoodie.html#request)
to handle success and error of the request.

### `hoodie.stripe.customers.retrieve`

```js
hoodie.stripe.customers.retrieve()
	.done(function( stripeCustomer ) {

	});
```
See [Stripe documentation](https://stripe.com/docs/api#retrieve_customer)
for details on this method and returned data.

See [Hoodie documentation](http://docs.hood.ie/en/techdocs/api/client/hoodie.html#request)
to handle success and error of the request.

### `hoodie.stripe.customers.update`

```js
hoodie.stripe.customers.update({
		// token obtained with Stripe.js, optional for free plans
		source: 'tok_16sgLrEHNnZkutNMqnfDXXXX',
	});
```
Required Stripe properties: None.

Accepted Stripe properties: `source`, `coupon`.

See [Stripe documentation](https://stripe.com/docs/api#update_customer)
for details on this method and its properties.

When a source is specified, if Taxamo is enabled, the following properties
are required: `currency_code`, `buyer_credit_card_prefix`.
And the following properties are accepted `buyer_email`, `buyer_tax_number`.

See [Taxamo documentation](https://www.taxamo.com/apidocs/api/v1/transactions/docs.html#POST)
for details on transaction properties.

See [Hoodie documentation](http://docs.hood.ie/en/techdocs/api/client/hoodie.html#request)
to handle success and error of the request.

### `hoodie.stripe.customers.update`

```js
hoodie.stripe.customers.updateSubscription({
		plan: 'stripe_plan_id'
	});
```
Required properties: None.

Accepted Stripe properties: `plan`, `coupon`, `source`.

See [Stripe documentation](https://stripe.com/docs/api#create_customer)
for details on this method and its properties.

When a source is specified, if Taxamo is enabled, the following properties
are required: `currency_code`, `buyer_credit_card_prefix`.
And the following properties are accepted `buyer_email`, `buyer_tax_number`.

See [Taxamo documentation](https://www.taxamo.com/apidocs/api/v1/transactions/docs.html#POST)
for details on transaction properties.

When this method succeed, the specified plan will appear in the user document
as the `stripe.plan` attribute, and in the user's roles, e.g.
`stripe:plan:<plan name>`.
See [Hoodie documentation](http://docs.hood.ie/en/techdocs/api/client/hoodie.html#request)
to handle success and error of the request.

## Handling Taxes

*What is Taxamo? Should I care about taxes?*

[Yes you should](https://rachelandrew.co.uk/archives/2014/10/13/the-horrible-implications-of-the-eu-vat-place-of-supply-change/).
More and more countries are adopting taxes for online goods and services,
**based on the country of consumption**. If you're based in the EU, not
complying would be suicidal. If you're based elsewhere, it won't take long until
EU [and other countries](https://www.taxamo.com/blog/) come after you to claim
their taxes. You can pray to be small enough to stay under radar, but you can't
hope for these rules to vanish. Taxamo takes care of keeping an eye on
international legislation for you, and calculating tax rate for every customer.

Taxamo is enabled simply by configuring your secret key in the dashboard.

### Universal Pricing

Universal pricing is a Taxamo feature that allows to get all customers to pay
the same price, no matter what their local tax rate is: in Stripe all
transactions appear with 0 tax, and in Taxamo, the transaction includes the
appropriate tax amount.

**Example**: Clara is a French customer willing to subscribe to your $10 plan.
Although VAT rate is 20% in France, we subscribe her to the $10 plan with 0 tax
on Stripe's side. On Taxamo's side, the transaction appears with a total amount
of $10, split in $8.33 + $1.66 VAT.

**Advantage**:
- you don't need to ask the country of origin of your customers, and then make
sure they didn't lie: one less field in the form, less confusion.
- some countries have laws that require prices to be always displayed with taxes
included (France, for example).

**Inconvenient**:
- Taxes are on you! You will earn [17% to 27%](https://en.wikipedia.org/wiki/European_Union_value_added_tax#VAT_rates)
less for EU customers, depending on their country of origin.
- Professional customers who have a VAT number and shouldn't pay VAT will pay
the same price.

To minimize the difference in income that EU customers will generate, you can
create plans with the euro currency for them, and let the plugin verify that EU
customers can only subscribe to those plans.

## Testing

In the console *(currently broken)*

You need to define two environment variables:
- HOODIE_URL: the url to your running Hoodie server
- STRIPE_KEY: your public Stripe key

`npm test`

In the browser

`npm run serve`

Then you need to add two query parameters to the test page url in the browser:
- HOODIE_URL: the url to your running Hoodie server (uri-encoded)
- STRIPE_KEY: your public Stripe key (uri-encoded)

## Contributing

This plugin needs you contribution! It's already used in production for
[Prototypo](http://www.prototypo.io) but need other users to make sure it is
generic enough for different use-cases. Get in touch if you're planning to
use this plugin!

Listening to Stripe WebHooks or using an alternative tax calculation backend
such as Quaderno, has been left as an exercise to the reader.
