# TODOS

## Roll spec (ID/OD) on sales orders
Deferred 2026-09-25 by /plan-ceo-review (D3). Work orders already carry ID/OD
(`idMM`/`odMM` in the WO doc, validated by `diaOf()` in productionService.js).
Next step: capture ID/OD on each sales-order line, validate it server-side in
`createSalesOrder`/`updateSalesOrder`, and copy it into the work order raised
for that line. The SO line grid must still fit a 1440px screen (see ISSUE-002).
The invoice already prints ID/OD through `lineRoll()` in mod-trade.js, reading
the line first and the batch's work order second.
