### Model exporter



We can dump a textured 3D model (*.obj with *.bmp and *.jpg) using the following scripts. They require [Node.js](https://nodejs.org/en/) v16+ and [npm](https://www.npmjs.com/):



```sh

# Install dependencies

npm install



# Region export from GeoJSON (recommended)
# auto picks level from bbox area; pass 22 for highest detail

node dump_region.js examples/google_hq.geojson auto --dry-run

node dump_region.js examples/google_hq.geojson 22 --proxy http://127.0.0.1:7890 --output ./downloaded_files/regions/google_hq-L22



# Legacy: find octant of latitude and longitude

node lat_long_to_octant.js 37.420806884765625 -122.08419799804688



# Legacy: dump octant with max-level 20

node dump_obj.js 20527061605273514 20

```



Region export details: see [REGION_MVP.md](REGION_MVP.md).



Exported files:

- Region mode: `./downloaded_files/regions/<name>-L<level>-<epoch>/`

- Legacy mode: `./downloaded_files/obj/`



They can be opened in Blender [like this](BLENDER.md). OSGB output can be imported into 大势智慧 after `osgconv` conversion.



#### Notes



Alternative methods for finding octants:

- LexSong wrote a Python script that takes bounding box coordinates to find octants: [LexSong/earth-reverse-engineering-utils](https://github.com/LexSong/earth-reverse-engineering-utils)

- Manually: [Open maps and dev tools, switch to satellite, fly to destination, search for NodeData, copy octant path from recent request](how_to_find_octant.jpg)



You can use this to dump json and raw data instead of obj:

```

node dump_obj.js 20527061605273514 20 --dump-json --dump-raw

```

