import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import package_corpus
from package_corpus import convert_corpus, pack_corpus
from tests.test_full_corpus import ordinary_record
from tests.test_training_assets import puzzle
from training_assets import (
    MAX_SAFE_INTEGER,
    canonical_record,
    encoded,
    export_assets,
    inventory_path,
    read_group,
    read_inventory,
)


def legacy_corpus(directory, schema):
    directory.mkdir()
    puzzles = [
        puzzle("z", 2000, themes=["endgame"], unusual={"source": "é♞"}),
        puzzle("a", 1400, untouched=[None, False, {"url": "source"}]),
    ]
    if schema == 2:
        puzzles = [canonical_record(record, "puzzles") for record in puzzles]
    position = ordinary_record()
    position["unknown"] = {"keep": [1, None, "all fields"]}
    position["scores"]["a7a5"] = "M-3"
    groups = {}
    for kind, records in (("puzzles", puzzles), ("ordinary", [position])):
        batches = (
            [[record] for record in puzzles] if kind == "puzzles" and schema == 2 else [records]
        )
        shards = []
        for batch in batches:
            content = gzip.compress(encoded(batch), mtime=0)
            prefix = "p" if kind == "puzzles" else "n"
            name = f"{prefix}-{hashlib.sha256(content).hexdigest()[:20]}.json.gz"
            (directory / name).write_bytes(content)
            shard = {"file": name, "count": len(batch)}
            if kind == "puzzles":
                if schema == 1:
                    shard["ratings"] = [p["rating"] for p in batch]
                else:
                    shard["rating"] = batch[0]["rating"]
            shards.append(shard)
        groups[kind] = {"count": len(records), "shards": shards}
    manifest = {
        "schema": schema,
        "dataset_id": "legacy-fixture",
        "engine": "Fixture",
        "nodes": 100000,
        "exporter_version": 1,
        "tolerance_cp": 50,
        "source_puzzles": "frozen.csv",
        "source_games": "frozen.pgn",
        "prepared_at": "original-timestamp",
        "unknown_metadata": {"keep": "yes"},
        **groups,
    }
    (directory / "manifest.json").write_bytes(encoded(manifest) + b"\n")
    return manifest, puzzles, [position]


def files(directory):
    return {
        str(path.relative_to(directory)): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize("schema", [1, 2])
def test_legacy_conversion_preserves_all_fields_grades_and_provenance_without_engine(
    tmp_path, monkeypatch, schema
):
    source, output, releases = tmp_path / "legacy", tmp_path / "converted", tmp_path / "releases"
    previous, puzzles, positions = legacy_corpus(source, schema)
    before = files(source)

    def forbidden(*args, **kwargs):
        pytest.fail("Engine/subprocess invocation during conversion or packaging")

    monkeypatch.setattr("engine.Engine.__init__", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    manifest = convert_corpus(source, output)
    candidate = pack_corpus(output, releases)
    assert manifest["schema"] == 3
    assert candidate["manifest"] == manifest
    assert candidate["format"] == 1
    assert manifest["prepared_at"] == previous["prepared_at"]
    assert manifest["unknown_metadata"] == previous["unknown_metadata"]
    actual = list(read_group(output, manifest["puzzles"], "puzzles"))
    normalized = sorted(
        (canonical_record(record, "puzzles") for record in puzzles),
        key=lambda record: (record["rating"], record["id"]),
    )
    assert actual == normalized
    if schema == 1:
        # Compare the original fields before/after, excluding exactly the one
        # documented schema-1 addition from the digest on both sides.
        def strip(records):
            return [{k: v for k, v in r.items() if k != "position_key"} for r in records]

        before_records = sorted(puzzles, key=lambda record: (record["rating"], record["id"]))
        assert encoded(strip(actual)) == encoded(strip(before_records))
    assert list(read_group(output, manifest["ordinary"], "ordinary")) == positions
    assert files(source) == before
    assert not any("checkpoint" in path or "cache" in path for path in files(output))
    report = json.loads((output / "conversion-report.json").read_bytes())
    assert report["format"] == 1
    assert report["verified"] is True
    assert report["source"] == {
        "schema": schema,
        "dataset_id": previous["dataset_id"],
        "manifest_sha256": hashlib.sha256(before["manifest.json"]).hexdigest(),
    }
    assert report["destination"] == {
        "schema": 3,
        "dataset_id": manifest["dataset_id"],
        "manifest_sha256": hashlib.sha256((output / "manifest.json").read_bytes()).hexdigest(),
    }
    assert report["before"] == report["after"]
    assert report["before"]["puzzles"]["rating_counts"] == [[1400, 1], [2000, 1]]
    for kind in ("puzzles", "ordinary"):
        inventory = read_inventory(output, manifest[kind], kind)
        assert inventory["provenance"] == candidate["archives"][kind]["provenance"]
        assert report["after"][kind]["count"] == inventory["count"]
        assert report["after"][kind]["logical_sha256"] == inventory["logical_sha256"]


def test_archives_and_candidate_are_deterministic_exact_authenticated_stored_and_fixed(tmp_path):
    source = tmp_path / "training"
    manifest = export_assets(
        source,
        [puzzle()],
        [{"id": "z"}, {"id": "a"}],
        {"prepared_at": "exact", "source_puzzles": "fixture"},
    )
    first_dir, second_dir = tmp_path / "first", tmp_path / "second"
    candidate = pack_corpus(source, first_dir)
    assert pack_corpus(source, second_dir) == candidate
    assert files(first_dir) == files(second_dir)
    assert (first_dir / "release-candidate.json").read_bytes() == encoded(candidate)
    assert not (first_dir / "candidate.json").exists()
    assert set(candidate) == {"format", "manifest", "archives"}
    assert candidate["manifest"] == json.loads((source / "manifest.json").read_bytes())
    for kind, descriptor in candidate["archives"].items():
        assert set(descriptor) == {
            "kind",
            "version",
            "file",
            "sha256",
            "bytes",
            "file_count",
            "extracted_bytes",
            "count",
            "provenance",
        }
        path = first_dir / descriptor["file"]
        assert descriptor["kind"] == kind
        assert descriptor["version"] == manifest[kind]["version"]
        assert descriptor["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert descriptor["bytes"] == path.stat().st_size
        assert descriptor["file"] == f"{kind}-{manifest[kind]['version']}.zip"
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            assert len(infos) == descriptor["file_count"]
            assert sum(info.file_size for info in infos) == descriptor["extracted_bytes"]
            assert infos[0].filename == inventory_path(manifest[kind], kind).as_posix()
            for info in infos:
                assert info.filename.startswith(f"{kind}/{manifest[kind]['version']}/")
                assert info.compress_type == zipfile.ZIP_STORED
                assert info.date_time == (1980, 1, 1, 0, 0, 0)
                assert info.external_attr >> 16 == 0o100644
                assert archive.read(info) == (source / info.filename).read_bytes()


def test_pack_is_a_separate_explicit_legacy_conversion_step(tmp_path):
    source = tmp_path / "legacy"
    legacy_corpus(source, 2)
    with pytest.raises(ValueError, match="convert first"):
        pack_corpus(source, tmp_path / "release")
    assert not (tmp_path / "release/release-candidate.json").exists()


def test_repeated_pack_retains_older_archives_and_never_overwrites_immutable_release(tmp_path):
    source, releases = tmp_path / "training", tmp_path / "release"
    export_assets(source, [puzzle()], [{"id": "a"}], {})
    first = pack_corpus(source, releases)
    old = {d["file"]: (releases / d["file"]).read_bytes() for d in first["archives"].values()}
    export_assets(source, [puzzle()], [{"id": "b"}], {})
    second = pack_corpus(source, releases)
    assert first["archives"]["puzzles"] == second["archives"]["puzzles"]
    assert first["archives"]["ordinary"] != second["archives"]["ordinary"]
    assert all((releases / name).read_bytes() == raw for name, raw in old.items())
    candidate_before = (releases / "release-candidate.json").read_bytes()
    (releases / second["archives"]["ordinary"]["file"]).write_bytes(b"corrupt immutable file")
    with pytest.raises(ValueError, match="Existing immutable archive differs"):
        pack_corpus(source, releases)
    assert (releases / "release-candidate.json").read_bytes() == candidate_before


def test_input_change_while_packing_leaves_previous_candidate_untouched(tmp_path, monkeypatch):
    source, releases = tmp_path / "training", tmp_path / "releases"
    export_assets(source, [puzzle()], [{"id": "a"}], {})
    pack_corpus(source, releases)
    previous = files(releases)
    original = package_corpus._write_archive

    def changed(*args):
        result = original(*args)
        if result["kind"] == "ordinary":
            (source / "manifest.json").write_bytes(encoded({"changed": True}))
        return result

    monkeypatch.setattr(package_corpus, "_write_archive", changed)
    with pytest.raises(ValueError, match="Input manifest changed"):
        pack_corpus(source, releases)
    assert files(releases) == previous


def test_corrupt_input_cannot_publish_a_candidate(tmp_path):
    source, releases = tmp_path / "training", tmp_path / "releases"
    manifest = export_assets(source, [puzzle()], [{"id": "a"}], {})
    inventory = read_inventory(source, manifest["puzzles"])
    path = source / inventory_path(manifest["puzzles"]).parent / inventory["shards"][0]["path"]
    path.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="SHA-256"):
        pack_corpus(source, releases)
    assert not (releases / "release-candidate.json").exists()


@pytest.mark.parametrize(
    ("convert_flag", "pack_flag"),
    [("--input", "--input"), ("--source", "--training-dir"), ("--training-dir", "--source")],
)
def test_engine_free_cli_convert_and_pack_accept_real_interfaces(
    tmp_path, monkeypatch, convert_flag, pack_flag
):
    source, output, release = tmp_path / "legacy", tmp_path / "training", tmp_path / "release"
    legacy_corpus(source, 1)
    monkeypatch.setenv("STOCKFISH", "/definitely/not/a/stockfish")
    for arguments in (
        [
            "convert",
            convert_flag,
            str(source),
            "--output",
            str(output),
            "--puzzle-shard-size",
            "128",
        ],
        ["pack", pack_flag, str(output), "--output", str(release)],
    ):
        result = subprocess.run(
            [sys.executable, "package_corpus.py", *arguments],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "Stockfish" not in result.stderr
    candidate = json.loads((release / "release-candidate.json").read_bytes())
    assert candidate["manifest"]["puzzles"]["shard_size"] == 128
    assert json.loads((output / "conversion-report.json").read_bytes())["verified"] is True


@pytest.mark.skipif(not shutil.which("node"), reason="Node is optional for Python tests")
@pytest.mark.parametrize("unicode", [False, True])
@pytest.mark.parametrize("ratings", [[1400], [-MAX_SAFE_INTEGER, -1, 0, 4001, MAX_SAFE_INTEGER]])
def test_python_groups_and_zip_archives_pass_actual_node_validation(tmp_path, unicode, ratings):
    source, release, extracted = tmp_path / "training", tmp_path / "release", tmp_path / "extracted"
    text = "é♞😀" if unicode else "plain"
    export_assets(
        source,
        [
            puzzle(f"p{index}", rating, note={"10": "ten", "2": text})
            for index, rating in enumerate(ratings)
        ],
        [{**ordinary_record(), "extra": text}],
        {"engine": "Fixture", "nodes": 100000, "sampled_games": 1, "source_puzzles": f"{text}.csv"},
    )
    candidate = pack_corpus(source, release)
    extracted.mkdir()
    code = """
      import fs from 'node:fs';
      import path from 'node:path';
      import { validateData } from './scripts/validate-data.mjs';
      import { extractArchive } from './scripts/training-data.mjs';
      const [source, release, extracted] = process.argv.slice(1);
      const candidate = JSON.parse(fs.readFileSync(path.join(release, 'release-candidate.json')));
      validateData(source, {deep: true, enforceBudgets: true});
      for (const descriptor of Object.values(candidate.archives)) {
        await extractArchive(path.join(release, descriptor.file), extracted, descriptor);
      }
      fs.writeFileSync(path.join(extracted, 'manifest.json'), JSON.stringify(candidate.manifest));
      validateData(extracted, {deep: true, enforceBudgets: true});
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code, str(source), str(release), str(extracted)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    for kind in ("puzzles", "ordinary"):
        assert list(read_group(extracted, candidate["manifest"][kind], kind)) == list(
            read_group(source, candidate["manifest"][kind], kind)
        )


def test_conversion_holds_both_source_and_output_locks_through_manifest_promotion(
    tmp_path, monkeypatch
):
    import training_assets

    source, output = tmp_path / "legacy", tmp_path / "converted"
    legacy_corpus(source, 1)
    original = training_assets.atomic_bytes
    observed = []

    def check_locked(path, raw):
        for directory in (source, output):
            owner = Path(str(directory.resolve()) + ".publication-lock") / "owner.json"
            assert json.loads(owner.read_bytes())["pid"] == os.getpid()
        observed.append(path)
        original(path, raw)

    monkeypatch.setattr(training_assets, "atomic_bytes", check_locked)
    convert_corpus(source, output)
    assert observed == [output / "manifest.json"]


@pytest.mark.parametrize(
    ("fault", "target", "mismatch"),
    [
        ("count", "puzzles", "count"),
        ("ratings", "puzzles", "rating_counts"),
        ("fields", "ordinary", "logical_sha256"),
    ],
)
def test_conversion_independently_compares_source_and_destination_before_promotion(
    tmp_path, monkeypatch, fault, target, mismatch
):
    import training_assets

    source, output = tmp_path / "source", tmp_path / "output"
    legacy_corpus(source, 1)
    export_assets(output, [puzzle("old")], [{"id": "old"}], {})
    before_source, before_output = files(source), files(output)
    original = training_assets._prepare_group

    def changed_prepare(work, records, kind, metadata, size):
        def altered():
            for index, record in enumerate(records):
                if kind == target and index == 0:
                    if fault == "count":
                        continue
                    if fault == "ratings":
                        record = {**record, "rating": record["rating"] + 1}
                    else:
                        record = {**record, "scores": {**record["scores"], "a7a5": "M-99"}}
                yield record

        return original(work, altered(), kind, metadata, size)

    monkeypatch.setattr(training_assets, "_prepare_group", changed_prepare)
    with pytest.raises(ValueError, match=f"Conversion {target} verification mismatch:.*{mismatch}"):
        convert_corpus(source, output)
    assert files(source) == before_source
    assert files(output) == before_output
    assert not (output / "conversion-report.json").exists()
    assert not list(output.glob(".corpus-building-*"))


def test_schema3_reconversion_retains_canonical_logical_signatures_for_safe_negative_ratings(
    tmp_path,
):
    source, output = tmp_path / "source", tmp_path / "output"
    original = export_assets(
        source,
        [
            puzzle("max", MAX_SAFE_INTEGER, extra={"unchanged": [None, False]}),
            puzzle("negative", -1),
            puzzle("min", -MAX_SAFE_INTEGER),
        ],
        [{"id": "z", "scores": {"move": "M-3"}}, {"id": "a", "other": [1, 2, 3]}],
        {"prepared_at": "original", "source_puzzles": "fixture"},
        puzzle_shard_size=256,
    )
    before = files(source)
    converted = convert_corpus(source, output, puzzle_shard_size=128)
    report = json.loads((output / "conversion-report.json").read_bytes())
    assert files(source) == before
    assert converted["puzzles"]["rating_counts"] == [
        [-MAX_SAFE_INTEGER, 1],
        [-1, 1],
        [MAX_SAFE_INTEGER, 1],
    ]
    assert converted["puzzles"]["shard_size"] == 128
    assert converted["puzzles"]["version"] != original["puzzles"]["version"]
    assert report["before"] == report["after"]
    for kind in ("puzzles", "ordinary"):
        assert list(read_group(source, original[kind], kind)) == list(
            read_group(output, converted[kind], kind)
        )
        source_inventory = read_inventory(source, original[kind], kind)
        assert report["before"][kind]["logical_sha256"] == source_inventory["logical_sha256"]


def test_conversion_rejects_source_manifest_change_before_publication(tmp_path, monkeypatch):
    import training_assets

    source, output = tmp_path / "source", tmp_path / "output"
    legacy_corpus(source, 2)
    export_assets(output, [puzzle("old")], [{"id": "old"}], {})
    before = files(output)
    original = training_assets._prepare_group

    def changed_prepare(work, records, kind, metadata, size):
        prepared = original(work, records, kind, metadata, size)
        if kind == "ordinary":
            manifest = json.loads((source / "manifest.json").read_bytes())
            (source / "manifest.json").write_bytes(encoded({**manifest, "changed": True}))
        return prepared

    monkeypatch.setattr(training_assets, "_prepare_group", changed_prepare)
    with pytest.raises(ValueError, match="Input manifest changed"):
        convert_corpus(source, output)
    assert files(output) == before


def test_conversion_requires_separate_output_to_preserve_source(tmp_path):
    source = tmp_path / "source"
    legacy_corpus(source, 1)
    before = files(source)
    with pytest.raises(ValueError, match="separate input/output directories"):
        convert_corpus(source, source)
    assert files(source) == before
