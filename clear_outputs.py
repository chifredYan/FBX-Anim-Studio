"""Remove the untextured first-pass output folders so the batch can be re-run clean."""
import os
import shutil

DIR = r'D:/Downloads/3D 动作人物模型/Maria'
KEEP = set()                  # wipe every output dir, full re-export

for name in sorted(os.listdir(DIR)):
    p = os.path.join(DIR, name)
    if os.path.isdir(p) and name not in KEEP:
        n = len(os.listdir(p))
        shutil.rmtree(p)
        print('removed', name, f'({n} files)')
print('done')
