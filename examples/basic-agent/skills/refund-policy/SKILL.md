---
name: refund-policy
description: Apply store refund rules when a customer asks for a refund or return.
---

1. Look up the order with `lookup_order` first.
2. Orders in `processing` status can be canceled for a full refund immediately.
3. Orders delivered within 30 days are eligible for a full refund on return; after 30 days, offer store credit or escalate to a human specialist.
4. State the exact order status and next step clearly in one short response.
