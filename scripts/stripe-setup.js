#!/usr/bin/env node
// One-time Stripe setup for 404 Mentions API billing.
// Creates: Product, Price ($10 = 100 credits), Payment Link.
// Usage: STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.js
//
// After running:
//   1. Print the payment link URL -> the buy page appends &client_reference_id=<api key>
//   2. Create the webhook endpoint in the Dashboard (or via CLI):
//      stripe webhook endpoints create \
//        --url https://mentions-api-404-production.up.railway.app/v1/billing/webhook \
//        --events checkout.session.completed
//      -> put the whsec_... into Railway STRIPE_WEBHOOK_SECRET
const Stripe = require('stripe');

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('Set STRIPE_SECRET_KEY env'); process.exit(1); }
  const stripe = Stripe(key);

  const product = await stripe.products.create({
    name: '404 Mentions API — Credit Pack',
    description: '100 live API calls. $1 = 10 credits. Credits never expire.',
  });
  console.log('product:', product.id);

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 1000, // $10.00
    currency: 'usd',
  });
  console.log('price:', price.id, '$10 = 100 credits');

  const link = await stripe.paymentLinks.create({
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': 1,
    allow_promotion_codes: false,
  });
  console.log('\npayment_link:', link.url);
  console.log('\nBuy URL pattern (append the buyer key):');
  console.log(`${link.url}?client_reference_id=<API_KEY>&prefill_email=<buyer_email>`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
