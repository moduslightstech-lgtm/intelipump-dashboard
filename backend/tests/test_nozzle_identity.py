"""Legacy DART channel pump-2 must resolve to physical pump-1 / nozzle-2."""

from app.services.nozzle_identity import NozzleCatalogEntry, canonicalize_identity


CATALOG = [
    NozzleCatalogEntry(
        physical_pump_id="pump-1",
        nozzle_id="nozzle-1",
        source_identifier="pump-1",
        aliases=["nozzle-1", "pump-1"],
    ),
    NozzleCatalogEntry(
        physical_pump_id="pump-1",
        nozzle_id="nozzle-2",
        source_identifier="pump-2",
        aliases=["nozzle-2", "pump-2"],
    ),
]


def test_legacy_pump_2_nozzle_1_maps_to_physical_nozzle_2():
    ident = canonicalize_identity(
        pump_id="pump-2",
        nozzle_id="nozzle-1",
        source_identifier="pump-2",
        catalog=CATALOG,
    )
    assert ident.mapped is True
    assert ident.pump_id == "pump-1"
    assert ident.nozzle_id == "nozzle-2"
    assert ident.source_identifier == "pump-2"


def test_legacy_pump_2_null_nozzle_maps_to_nozzle_2():
    ident = canonicalize_identity(pump_id="pump-2", nozzle_id=None, catalog=CATALOG)
    assert ident.mapped is True
    assert ident.pump_id == "pump-1"
    assert ident.nozzle_id == "nozzle-2"


def test_failed_mapping_does_not_assign_nozzle_1():
    ident = canonicalize_identity(
        pump_id="pump-99",
        nozzle_id=None,
        source_identifier="unknown",
        catalog=CATALOG,
    )
    assert ident.mapped is False
    assert ident.nozzle_id != "nozzle-1"
    assert ident.warning


def test_nozzle_1_identity_unchanged():
    ident = canonicalize_identity(
        pump_id="pump-1",
        nozzle_id="nozzle-1",
        source_identifier="pump-1",
        catalog=CATALOG,
    )
    assert ident.pump_id == "pump-1"
    assert ident.nozzle_id == "nozzle-1"
