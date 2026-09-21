# PROTOTYPE — workflow workspace

Throwaway low-fidelity UI used to validate one product decision:

> Trace, review, and storyboard are three retained work modes over the same project data, not competing variants.

Run:

```bash
npm run prototype
```

Open <http://localhost:4173>. Switch modes with the floating bottom bar, keyboard arrow keys, or `?mode=trace`, `?mode=review`, and `?mode=storyboard`. Legacy `?variant=A/B/C` links remain readable.

Mode switching preserves the current in-memory selection and workflow state. In the product, the same rule applies to persisted canonical project data.

This prototype has no backend or persistence and must not be promoted directly into production code.
