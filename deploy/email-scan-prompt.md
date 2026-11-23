Scan Houston's Outlook for packages shipping to the Alexandria office and add them to the Office Packages tracker.

OFFICE ADDRESS: 726 N Washington St, Alexandria, VA 22314.
TRACKER API: https://package.rossmoncure.com
TOKEN: <create one under Admin → Email-scan tokens; the live copy lives only in the scheduled task>   (send as header `Authorization: Bearer <TOKEN>`)
WINDOW: emails received in the last {{DAYS}} days. Re-sending something already known is safe — the API de-duplicates by source_ref.

## 1. See what the tracker already knows
With the bash tool: `curl -s -H "Authorization: Bearer <TOKEN>" https://package.rossmoncure.com/api/import/open`
If this fails with a network error, stop and report that the tracker could not be reached — do not try other ways to reach it.

## 2. Find candidate emails (Microsoft 365 / Outlook connector, Houston's own mailbox, all folders)
Run these searches with afterDateTime = the window start, paging through every page:
- sender `shipment-tracking@amazon.com` (Shipped / Out for delivery / Delivered)
- sender `order-update@amazon.com` (Delivery update / delayed)
- sender `ebay@ebay.com`
- query `"tracking number"`
- query `"out for delivery"`
- query `shipped`
- query `delivered`
Skip obvious non-shipments by subject (restaurant "Order Confirmation: OD-…" from oftendining.com, QuickBooks "Departure Invoice", guest replies, marketing).

## 3. Decide if each email is a package going to the office
Read the email (read_resource; if it is too large to return inline, parse the saved file with python in bash). It counts ONLY if the SHIP-TO / delivery address is the office:
- Amazon: the shipment card shows "<Name> - ALEXANDRIA, VA" (Amazon never shows the street). That is the office.
- Others: the ship-to / delivery address contains 726 N Washington St or Alexandria, VA 22314.
- Bluefields Bay Villas' own email signature/footer contains this address — that does NOT count. Nor does a sender's own footer (e.g. ASTA in Alexandria).
- Amazon "Ordered …" emails from auto-confirm@amazon.com: SKIP — wait for the "Shipped" email, which carries the shipment.
- Non-Amazon vendors that only send an order confirmation (ship-to = office, estimated delivery given): include with carrier_status "ordered".
- Carrier notifications (UPS/FedEx/USPS "delivered", "out for delivery") usually show no address. Send one ONLY when its tracking number is already in the tracker (step 1 list) or it clearly belongs to a vendor email in this scan that shipped to the office — then it is an update. Otherwise do not send it; list it under "unsure" in the report with tracking number and shipper.
- Amazon "Delivered" emails count (same shipment card).

## 4. Build one item per SHIPMENT (not per email)
{
  "source_ref":   REQUIRED, stable for the shipment across all its emails:
                  - carrier tracking number if the email shows one (uppercase, no spaces), else
                  - Amazon: "amazon:<order #>:<shipmentId>" — shipmentId is the `shipmentId%3D…` value inside the "Track package" link (URL-decoded, e.g. NkTNnZMbd)
                  - other: "<vendor>:<order #>"
  "vendor":       "Amazon", "eBay", "Ubiquiti", …
  "carrier":      UPS / FedEx / USPS / DHL if named; "Amazon" for Amazon shipments that name none
  "tracking":     tracking number if shown
  "order_number": order number (strip invisible characters such as U+202B)
  "description":  short, "<what> (<n> items)", e.g. "Light Bulbs (5 items)" — from the Amazon subject. (The tracker keeps the first description it got; later ones don't rename it.)
  "label_name":   name on the shipment card, e.g. "Andrew"
  "expected_date":"YYYY-MM-DD". Resolve "Arriving Friday"/"tomorrow"/"today" against the email's received date in US Eastern time. For a range, use the LAST day.
  "carrier_status": one of ordered, shipped, in_transit, delayed, out_for_delivery, delivered, exception, cancelled — from the email
  "delivered_at": ISO timestamp, only when carrier_status is delivered (use the email's received time if no better time)
  "email_link":   the email's webLink
}
When several emails exist for the same shipment, send the item built from the NEWEST one (latest status and date).

## 5. Send to the tracker
Write the items to a JSON file and POST in batches of up to 100:
`curl -s -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" --data @items.json https://package.rossmoncure.com/api/import`
Body shape: {"packages":[ …items… ]}. The response lists created / updated / attached / unchanged / error per item. Fix and resend any "error" item once.

## 6. Report
Reply with a short summary: how many emails checked, how many shipments sent, and the API's created / updated / unchanged / error counts, plus a one-line list of anything NEW (description + expected date). Note any email you were unsure about. Do not email anyone.
