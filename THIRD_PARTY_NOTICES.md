# Third-party notices

The disposable-container installation probe is derived from
[`DshMarketPlace/dsh-plugin-validator`](https://github.com/DshMarketPlace/dsh-plugin-validator),
copyright 2026 DshMarketPlace, used under the MIT License.

The original project established several important verification rules retained here:

- do not trust the `dsh plugin add` exit code;
- verify registration from the profile manifest written by DSH;
- run every untrusted plugin in a disposable, unprivileged container;
- treat registry throttling as an inconclusive runner result, not a plugin failure;
- distinguish blocked build approval and non-layer packages from defects.

The complete upstream MIT license is available at:
https://github.com/DshMarketPlace/dsh-plugin-validator/blob/main/LICENSE
