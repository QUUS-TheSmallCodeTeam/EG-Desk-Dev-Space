// The registrations of the real-engine check's extensions (API: ./egdesk-real-engine-extensions.mjs), one module per lane in helper/real-engine-registrations/ (c33: this file used to hold every
// lane's section and conflicted on almost every merge). A lane edits ONLY its own file and appends at the END of it; this file changes only when a lane is added.
// The import order below is fixed and is the registration order (turn hooks attach and merge records in it). Ordering rules that must hold (tested in egdesk-real-engine-extensions.test.mjs):
//   memory (L7) before journey (L2): the records and expectations of memory come before journey's;   rewrite (L2) before planted (L6): the planted hook wraps checkHeldDraft AFTER the rewrite hook copied it.
import './real-engine-registrations/L1.mjs'
import './real-engine-registrations/L7.mjs'
import './real-engine-registrations/L2.mjs'
import './real-engine-registrations/L6.mjs'
import './real-engine-registrations/L3.mjs'
import './real-engine-registrations/L4.mjs'
import './real-engine-registrations/L8.mjs'
import './real-engine-registrations/L5.mjs'
