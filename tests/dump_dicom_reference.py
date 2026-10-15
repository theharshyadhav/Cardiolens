#!/usr/bin/env python3
"""Reference values for tests/test_dicom.js: what pydicom reads from every DICOM file under a folder.
   python tests/dump_dicom_reference.py <folder> <out.json>"""
import glob, json, os, sys, warnings
import numpy as np
import pydicom
warnings.filterwarnings("ignore")
root, out = sys.argv[1], sys.argv[2]
rows = []
for f in sorted(glob.glob(os.path.join(root, "**", "*"), recursive=True)):
    if not os.path.isfile(f) or not f.lower().endswith(".dcm"):
        continue
    d = pydicom.dcmread(f)
    a = d.pixel_array.astype(np.int64)
    num = lambda k: (float(d[k].value) if k in d else None)
    lst = lambda k: ([float(x) for x in d[k].value] if k in d else None)
    rows.append(dict(name=os.path.relpath(f, root), sop=str(d.SOPInstanceUID), modality=str(d.Modality), rows=int(d.Rows), cols=int(d.Columns),
                     bits=int(d.BitsAllocated), signed=int(d.PixelRepresentation), ipp=lst("ImagePositionPatient"), iop=lst("ImageOrientationPatient"),
                     px=lst("PixelSpacing"), trigger=num("TriggerTime"), instance=int(d.InstanceNumber), nominal=num("NominalInterval"), hr=num("HeartRate"),
                     slope=num("RescaleSlope"), intercept=num("RescaleIntercept"), thickness=num("SliceThickness"),
                     sum=int(a.sum()), sumsq=int((a * a).sum()), first=int(a.flat[0]), last=int(a.flat[-1]), mid=int(a.flat[a.size // 2])))
json.dump(rows, open(out, "w"))
print(len(rows), "files ->", out)
