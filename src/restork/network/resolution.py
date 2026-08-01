"""Public-address classification for dynamic exact-origin capabilities."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Protocol

_LOCAL_SUFFIXES = (".local", ".localhost", ".internal", ".home.arpa")


class AddressResolutionError(PermissionError):
    """The destination could not be proven to resolve only to public addresses."""


class AddressResolver(Protocol):
    def resolve(self, hostname: str) -> tuple[str, ...]: ...


class SocketAddressResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        records = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        return tuple(sorted({str(record[4][0]) for record in records}))


async def require_public_resolution(
    hostname: str,
    resolver: AddressResolver,
) -> tuple[str, ...]:
    require_public_hostname(hostname)
    try:
        addresses = await asyncio.to_thread(resolver.resolve, hostname)
    except OSError as error:
        raise AddressResolutionError("hostname could not be resolved") from error
    if not addresses:
        raise AddressResolutionError("hostname resolved to no address")
    try:
        parsed_addresses = tuple(ipaddress.ip_address(address) for address in addresses)
    except ValueError as error:
        raise AddressResolutionError("hostname returned an invalid address") from error
    if any(not address.is_global for address in parsed_addresses):
        raise AddressResolutionError("hostname resolved outside the public Internet")
    return addresses


def require_public_hostname(hostname: str) -> None:
    normalized = hostname.lower()
    if (
        normalized.endswith(".")
        or normalized == "localhost"
        or normalized.endswith(_LOCAL_SUFFIXES)
    ):
        raise AddressResolutionError("local and internal hostnames are forbidden")
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        return
    raise AddressResolutionError("IP-literal destinations are forbidden")
