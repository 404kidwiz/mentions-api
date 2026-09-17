#!/usr/bin/env bash
# 404 Mentions API — end-to-end smoke test
set -e
BASE=http://127.0.0.1:8791
echo "== create business =="
BIZ=$(curl -s -X POST $BASE/ops/businesses -H 'content-type: application/json' -d '{"name":"smoke test brand"}')
echo "$BIZ"
KEY=$(echo "$BIZ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).key))")
echo "KEY=$KEY"

echo "== sandbox call (free, sample posts) =="
curl -s "$BASE/v1/mentions?product=standing%20desk&days=90&sample=true" -H "Authorization: Bearer $KEY" | head -c 600
echo; echo "== billed call =="
curl -s "$BASE/v1/mentions?product=running%20shoes&days=90" -H "Authorization: Bearer $KEY" | head -c 600
echo; echo "== bad window (error, never billed) =="
curl -s "$BASE/v1/mentions?product=x&days=9999" -H "Authorization: Bearer $KEY"
echo; echo "== missing product =="
curl -s "$BASE/v1/mentions" -H "Authorization: Bearer $KEY"
echo; echo "== no key =="
curl -s "$BASE/v1/mentions?product=x"
echo; echo "== stats =="
curl -s $BASE/ops/stats
echo; echo "== receipts =="
curl -s "$BASE/ops/receipts?limit=5"
echo
