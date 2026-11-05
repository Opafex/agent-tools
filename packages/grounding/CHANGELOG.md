# Changelog

Releases before 0.10.0 are recorded in the commit history.

## 0.10.0

### New

- `checkGroundedItems({ call, transcript, declaration }, options?)`: a pre-call check for a list argument. A tool declares which array holds the items (`param`), which field holds each name (`field`) and which fields hold a web or email address (`addressFields`). Each item must have been named by the person or by another tool's result, by its name on whole words or by the registrable domain of an address. `systemEvidence` defaults to `'none'` here.
- `ungroundedItemsMessage`, and the types `GroundedItemsDeclaration`, `GroundedItemsOptions`, `GroundedItemsResult` and `UngroundedItem`.

### Changed

Nothing. No existing check, export or default behaves differently from 0.9.0, and no existing test was edited.

`CHANGELOG.md` now ships in the package.
