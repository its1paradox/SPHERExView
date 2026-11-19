# Dashboard launches and progress

The WISE–SPHEREx and six-detector links open a fresh tab on every click.
New-target and refresh actions reserve their tab during the click, before
writing to IndexedDB, so asynchronous storage does not trigger popup blocking.
A blocked popup is reported without starting a refresh.

Each tool has independent activity records in the existing local research
database. Storage events notify other tabs, with a five-second polling fallback.
Only a change token enters localStorage; research coordinates, progress and
results remain in IndexedDB. No server history or additional persistent server
cache is introduced.

The dashboard distinguishes waiting for server capacity, processing, saving
on this device, ready, partial, failed, cancelled, and stale progress. Detector
processing counts come from the job API. Timeline discovery/processing is
indeterminate because that endpoint does not expose intermediate counts. File
saving reports actual completed transfers. Percentages describe a stage, not an
invented overall completion estimate.

Results become ready only after the local snapshot and all of its export/frame
files commit. Concurrent WISE/SPHEREx requests keep the tool active until every
request finishes. A failed mission remains visible when another succeeds.
Activity writes respect target revisions and refresh generations, so a removed
or cleared library entry cannot be resurrected by an older operation.

Keep the tool tab open during processing and saving. After three minutes with
no heartbeat, the dashboard asks the user to open the tool to check progress;
it does not claim that the server has stopped. Reopening an unfinished detector
refresh resumes its newer pending job, even when older saved results exist.

## Validation

- Automated coverage: new-tab attributes, popup blocking, synchronous tab
  reservation, cross-tab progress events, parallel mission completion/failure,
  detector processing versus local save completion, stale progress, refresh
  resumption, quota failures, deletion races, exact local byte accounting, and
  saving all 1,007 timeline frames.
- Chrome: new-target launch, both saved tool links, detector refresh in a new
  tab, independent live processing and file-saving counts, completed partial
  states using recorded real observations, desktop and 390/320-pixel layouts.
- The recorded detector run processed all 268 selected inputs; all 3,860
  numerical arrays matched their corresponding FITS exports exactly (291
  verified HDUs). Missing/unusable inputs remained explicitly labelled partial.

This UI change does not modify scientific formulas, sampling or input selection.
