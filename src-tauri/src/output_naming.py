"""Owned-backend adapter: clean saver suffixes only for marked DEAS submissions."""
import functools
import os
from pathlib import Path
import re

import folder_paths
import nodes
from server import PromptServer


def wrap_save(save):
    @functools.wraps(save)
    def save_images(self, *args, **kwargs):
        result = save(self, *args, **kwargs)
        if not (kwargs.get("extra_pnginfo") or {}).get("deas_output_naming"):
            return result
        for image in result.get("ui", {}).get("images", []):
            if image["type"] != "output":
                continue
            match = re.fullmatch(r"(.+)_(\d+)_\.(png|webp|jpg|jpeg)", image["filename"])
            if not match:
                continue
            folder = Path(folder_paths.get_output_directory()) / image["subfolder"]
            source = folder / image["filename"]
            prefix, counter, extension = match.groups()
            counter = int(counter)
            while True:
                filename = f"{prefix}-{counter:05}.{extension}"
                try:
                    # A hard link publishes without overwriting an existing output, on Linux and Windows.
                    os.link(source, folder / filename)
                    break
                except FileExistsError:
                    counter += 1
            source.unlink()
            image["filename"] = filename
        return result
    return save_images


def prepare(data):
    if data.get("extra_data", {}).get("extra_pnginfo", {}).get("deas_output_naming"):
        for name in ("SaveImage", "DaSiWa_MetadataImageSaver"):
            cls = nodes.NODE_CLASS_MAPPINGS.get(name)
            if cls and not getattr(cls.save_images, "_deas_naming", False):
                cls.save_images = wrap_save(cls.save_images)
                cls.save_images._deas_naming = True
    return data


PromptServer.instance.add_on_prompt_handler(prepare)
NODE_CLASS_MAPPINGS = {}
