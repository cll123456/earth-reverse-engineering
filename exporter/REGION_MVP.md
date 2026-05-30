# Region Exporter

GeoJSON 区域导出工具：自动查找 octant、下载 Google Earth 3D 模型、投影坐标、分块输出 OSGB 目录结构。

## 功能概览

| 阶段 | 能力 |
|------|------|
| A | GeoJSON 多边形裁剪、bbox→octant、自动 level、磁盘缓存、断点续传、分块输出 |
| B | ECEF→WGS84→目标 EPSG、自动/手动坐标系、`SRSOrigin`、`metadata.xml` |
| C | `Data/Tile_*/` 目录结构、OBJ 分块、`osgconv` 转 OSGB |
| D | 完整 CLI、HTTP 限速、单元测试 |

## 安装

```sh
cd exporter
npm install
```

需要 Node.js >= 16。

OSGB 转换还需要安装 [OpenSceneGraph](https://www.openscenegraph.org/)，并确保 `osgconv` 在 PATH 中。

## 快速开始

```sh
# 1. 预览 octant 和坐标参数
node dump_region.js examples/google_hq.geojson auto --dry-run

# 2. 导出区域（自动 level + 裁剪 + 投影 + OSGB 目录）
node dump_region.js examples/google_hq.geojson auto

# 3. 指定 level 和坐标系
node dump_region.js examples/google_hq.geojson 16 --epsg 4547 --output ./output/hq
```

## 输出结构

```text
downloaded_files/regions/google_hq-L16-{epoch}/
  metadata.xml
  region-manifest.json
  .region-progress.json
  Data/
    Tile_3050123456789012/
      Tile_3050123456789012.obj
      Tile_3050123456789012.mtl
      Tile_3050123456789012.osgb   # 若已安装 osgconv
      tex_*.jpg / tex_*.bmp
```

## CLI 参数

```text
node dump_region.js [geojson_file] [max_level|auto] [options]

Options:
  --output <dir>         输出目录
  --epsg <code|auto>     目标投影，默认 auto（中国区域自动选 CGCS2000 3°带）
  --no-clip              关闭 GeoJSON 多边形裁剪
  --no-resume            关闭断点续传
  --no-cache             关闭 HTTP 磁盘缓存
  --no-osgb              跳过 osgconv 转换
  --parallel-search      并行遍历八叉树
  --rate-limit-ms <n>    HTTP 请求最小间隔（默认 100ms）
  --max-octants <n>      最大 octant 数（默认 500）
  --dry-run              只解析参数和 octant
```

## 辅助命令

```sh
# 仅把已有输出目录中的 OBJ 转为 OSGB
node convert_to_osgb.js ./downloaded_files/regions/google_hq-L16-123

# 运行单元测试
npm test

# 旧版单 octant 导出（兼容保留）
node dump_obj.js 20527061605273514 20
```

## 导入大势智慧

1. 确认 `metadata.xml` 中 `SRS` 和 `SRSOrigin` 正确
2. 确认 `Data/Tile_*/` 下存在 `.osgb` 文件
3. 若只有 `.obj`，先安装 OpenSceneGraph 后执行 `node convert_to_osgb.js <output_dir>`
4. 在大势智慧中选择「倾斜摄影/OSGB 模型」导入输出目录

## 网络与代理

浏览器能访问 Google，不代表 Node.js 也能。Node 默认**不会**走系统 VPN/代理。

如果你使用 Clash / V2Ray 等工具，请先设置代理再运行：

```powershell
# PowerShell 示例，端口按你的代理软件修改
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
node dump_region.js examples/google_hq.geojson auto --dry-run
```

或直接传参：

```sh
node dump_region.js examples/google_hq.geojson auto --proxy http://127.0.0.1:7890
```

## GeoJSON 坐标系

支持 WGS84 经纬度，也支持 GeoJSON 内声明的 `EPSG:3857`（Web Mercator）等投影坐标，程序会自动重投影到 WGS84。

- `examples/google_hq_wgs84.geojson`：WGS84 示例（Google 总部附近）
- `examples/google_hq.geojson`：若来自 QGIS/ArcGIS 导出，可能是 EPSG:3857


- 裁剪基于三角形重心是否在多边形内，边界处可能略有误差
- 大范围 + 高 level 数据量很大，建议先用 `--dry-run` 和 `auto` level
- 数据来自 Google Earth 服务，请注意版权与使用条款
