import json

import pytest

import package_corpus
from package_corpus import pack_corpus
from tests.test_training_assets import puzzle
from training_assets import encoded, export_assets


def files(directory):
    return {
        str(path.relative_to(directory)): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize("has_previous", [False, True])
def test_concurrent_newer_candidate_aborts_stale_pack_before_promoting_any_archive(
    tmp_path, monkeypatch, has_previous
):
    source, newer, releases = tmp_path / "slow", tmp_path / "newer", tmp_path / "releases"
    export_assets(source, [puzzle("slow")], [{"id": "slow"}], {})
    export_assets(newer, [puzzle("newer")], [{"id": "newer"}], {})
    releases.mkdir()
    if has_previous:
        previous = tmp_path / "previous"
        export_assets(previous, [puzzle("previous")], [{"id": "previous"}], {})
        pack_corpus(previous, releases)
    (releases / "unrelated-old-archive.zip").write_bytes(b"preserve existing release files")
    existing = files(releases)
    original, update = package_corpus._write_archive, {}

    def concurrent_pack(*args):
        descriptor = original(*args)
        if descriptor["kind"] == "ordinary" and not update:
            # Simulate a second pack from a different frozen source while this
            # older pack is still doing long work outside its publication lock.
            update["started"] = True
            update["candidate"] = pack_corpus(newer, releases)
            update["files"] = {
                name: raw
                for name, raw in files(releases).items()
                if not name.startswith(".corpus-pack-")
            }
        return descriptor

    monkeypatch.setattr(package_corpus, "_write_archive", concurrent_pack)
    with pytest.raises(ValueError, match="Release candidate changed during packaging"):
        pack_corpus(source, releases)
    assert files(releases) == update["files"]
    assert json.loads((releases / "release-candidate.json").read_bytes()) == update["candidate"]
    assert all(
        (releases / name).read_bytes() == raw
        for name, raw in existing.items()
        if name != "release-candidate.json"
    )
    assert not list(releases.glob(".corpus-pack-*"))


def test_identical_concurrent_pack_is_idempotent_when_another_pack_publishes_first(
    tmp_path, monkeypatch
):
    source, releases = tmp_path / "source", tmp_path / "releases"
    export_assets(source, [puzzle()], [{"id": "ordinary"}], {})
    original, update = package_corpus._write_archive, {}

    def identical_pack(*args):
        descriptor = original(*args)
        if descriptor["kind"] == "ordinary" and not update:
            update["started"] = True
            update["candidate"] = pack_corpus(source, releases)
            update["archives"] = {
                entry["file"]: (
                    (releases / entry["file"]).read_bytes(),
                    (releases / entry["file"]).stat().st_ino,
                )
                for entry in update["candidate"]["archives"].values()
            }
        return descriptor

    monkeypatch.setattr(package_corpus, "_write_archive", identical_pack)
    assert pack_corpus(source, releases) == update["candidate"]
    assert (releases / "release-candidate.json").read_bytes() == encoded(update["candidate"])
    for name, (raw, inode) in update["archives"].items():
        assert (releases / name).read_bytes() == raw
        assert (releases / name).stat().st_ino == inode
    assert not list(releases.glob(".corpus-pack-*"))
