#!/usr/bin/env bash
# One-time (idempotent) Stripe setup for Agent Soup: the Pro product and its prices (found at runtime by lookup key),
# the customer portal, and the webhook endpoint. Prints nothing secret except the new webhook secret's destination.
# Usage: scripts/stripe-setup.sh [base_url]   (key from secrets.txt: "stripe secret key (test)")
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-https://agent-board.vedu-mallela.workers.dev}"
SK="${STRIPE_SECRET_KEY:-$(grep -i '^stripe secret key (test)' secrets.txt | sed -E 's/^[^-]*- *//')}"
api() { curl -sS -u "$SK:" -H "Stripe-Version: 2024-06-20" "$@"; }  # pinned: the account default is old
have_price() { api -G https://api.stripe.com/v1/prices --data-urlencode "lookup_keys[]=$1" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')"; }
prod=$(api -G https://api.stripe.com/v1/products/search --data-urlencode "query=metadata['app']:'agent-soup'" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')")
if [ -z "$prod" ]; then
  prod=$(api https://api.stripe.com/v1/products -d name="Agent Soup Pro" -d "description=Unlimited boards, up to 50 members per board" -d "metadata[app]=agent-soup" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
fi
echo "product $prod"
# Pro: $10/month or $100/year. A changed amount creates a new price and moves the lookup key to it (old subscribers keep theirs).
price_amount() { api -G https://api.stripe.com/v1/prices --data-urlencode "lookup_keys[]=$1" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d[0]['unit_amount'] if d else '')"; }
ensure_price() { # lookup amount interval
  [ "$(price_amount "$1")" = "$2" ] || api https://api.stripe.com/v1/prices -d product="$prod" -d currency=usd -d unit_amount="$2" -d "recurring[interval]=$3" -d lookup_key="$1" -d transfer_lookup_key=true >/dev/null
}
ensure_price pro_monthly 1000 month
ensure_price pro_yearly 10000 year
echo "prices pro_monthly=$(have_price pro_monthly) pro_yearly=$(have_price pro_yearly)"
# Customer portal: cancel, switch monthly/yearly, update payment method, invoices.
portal=$(api -G https://api.stripe.com/v1/billing_portal/configurations -d active=true -d limit=1 | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')")
if [ -z "$portal" ]; then
  api https://api.stripe.com/v1/billing_portal/configurations \
    -d "business_profile[headline]=Agent Soup" \
    -d "features[invoice_history][enabled]=true" -d "features[payment_method_update][enabled]=true" \
    -d "features[subscription_cancel][enabled]=true" -d "features[subscription_cancel][mode]=at_period_end" \
    -d "default_return_url=$BASE/me" >/dev/null
  echo "portal configured"
else echo "portal $portal"; fi
# Webhook: create once, then store its signing secret as a Worker secret (never printed).
hook=$(api -G https://api.stripe.com/v1/webhook_endpoints -d limit=100 | python3 -c "import json,sys;b=sys.argv[1];d=[w for w in json.load(sys.stdin)['data'] if w['url']==b+'/stripe/webhook'];print(d[0]['id'] if d else '')" "$BASE")
if [ -z "$hook" ]; then
  secret=$(api https://api.stripe.com/v1/webhook_endpoints -d url="$BASE/stripe/webhook" \
    -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" | python3 -c "import json,sys;print(json.load(sys.stdin)['secret'])")
  printf '%s' "$secret" | npx wrangler secret put STRIPE_WEBHOOK_SECRET >/dev/null 2>&1 && echo "webhook created; signing secret stored as STRIPE_WEBHOOK_SECRET"
  grep -q '^stripe webhook secret (test)' secrets.txt || printf '\nstripe webhook secret (test) - %s\n' "$secret" >> secrets.txt
else echo "webhook $hook (exists)"; fi
