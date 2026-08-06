"""Restork's deprecated Python Core.

Superseded by the native Rust Core in `rust/crates/restorkd`, which is what the
desktop application ships and what `scripts/quickstart.sh` starts. This package
is retained only as a porting reference and as the host for the release-blocking
gates that do not yet have Rust counterparts.

It is removed in Stage 6 of `specs/restork-single-core-consolidation.md`, once
Memory, Tasks, the Research evidence layer, and Work's verification mechanism
have been ported and the 14 named gates run against Rust.

Do not add features here.
"""

__version__ = "0.1.2"
__deprecated__ = True
