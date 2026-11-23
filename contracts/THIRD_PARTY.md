# Third-party code in contracts/

`src/CreatureWallet.sol`, `src/WeightlingsFactory.sol`, `src/WeightlingsTreasury.sol` and the tests in `test/`
are ported from Zero Lux (`AgentWalletV3.sol`, `ZeroLuxFactoryV3.sol`, `ZeroLuxTreasury.sol`, and
`V3.t.sol`, `ReviewV3.t.sol`, `InvariantV3.t.sol`, `ForkV3.t.sol`). Only contract, interface and file names
were changed; the logic is byte-for-byte the same text after the renames.

`lib/forge-std` is forge-std 1.16.2 (MIT or Apache-2.0), see its own license files.

```
MIT License

Copyright (c) 2026 Zero Lux

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
