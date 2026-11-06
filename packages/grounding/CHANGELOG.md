# Changelog

Releases before 0.10.0 are recorded in the commit history.

## 0.10.0

### New

- `checkGroundedItems({ call, transcript, declaration }, options?)`: a pre-call check for a list argument. A tool declares which array holds the items (`param`), which field holds each name (`field`) and which fields hold a web or email address (`addressFields`). Each item must have been named by the person or by another tool's result, by its name on whole words or by the registrable domain of an address. `systemEvidence` defaults to `'none'` here.
- `ungroundedItemsMessage`, and the types `GroundedItemsDeclaration`, `GroundedItemsOptions`, `GroundedItemsResult` and `UngroundedItem`.
- `checkGroundedRows({ call, transcript, declaration }, options?)`: a pre-call check for table rows. The declaration names an array of rows (`param`), one row (`single`) or rows held under a key (`field`). A value that is wholly an email address is read in any column, and any other value only in a column that names a firm or a person. Each must have been named by the person or by another tool's result. `ungroundedRowsMessage`, and the types `GroundedRowsDeclaration`, `GroundedRowsOptions` and `GroundedRowsResult`.
- `checkGroundedAddresses({ call, transcript, declaration }, options?)`: a pre-call check for the arguments a tool declares as recipients (`params`). Each address must have been named whole, and a value that cannot be read as an address is refused. `ungroundedAddressesMessage`, and the types `GroundedAddressesDeclaration`, `GroundedAddressesOptions`, `GroundedAddressesResult` and `UngroundedAddress`.
- All three compare a value as what it is: an email address whole, a web address by registrable domain, a name on whole words. A web address is never compared as words, so `smith.co.uk` is not grounded by `john-smith.co.uk`, and a trailing full stop does not reduce `invented.com.` to `com`.

### Changed

Nothing. No existing check, export or default behaves differently from 0.9.0, and no existing test was edited.

`CHANGELOG.md` now ships in the package.
