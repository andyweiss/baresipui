#!/usr/bin/env python3
"""
Script to properly update the re-sipreg-public-ip.patch with enhanced debugging
"""

import subprocess
import os
import tempfile
import shutil

def main():
    # Clone libre temporarily
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Cloning libre to {tmpdir}...")
        subprocess.run(['git', 'clone', '--depth', '1', 'https://github.com/baresip/re.git', tmpdir], check=True)
        
        reg_c = os.path.join(tmpdir, 'src/sipreg/reg.c')
        
        # Read the original file
        with open(reg_c, 'r') as f:
            original_content = f.read()
        
        # Create backup
        with open(reg_c + '.orig', 'w') as f:
            f.write(original_content)
        
        # Apply the original patch first
        print("Applying original patch...")
        os.chdir(tmpdir)
        with open('re-sipreg-public-ip.patch', 'w') as f:
            with open('/home/debdev/baresipui/baresip/patches/re-sipreg-public-ip.patch', 'r') as orig:
                f.write(orig.read())
        
        subprocess.run(['patch', '-p1', '<', 're-sipreg-public-ip.patch'], shell=True, check=True)
        
        # Now read the patched file and add more debug output
        with open(reg_c, 'r') as f:
            content = f.read()
        
        # Find the section we need to modify - the 407 case
        old_code = '''\t\t/* Extract public IP from Via received parameter */
\t\t{
\t\t\tstruct pl received;
\t\t\tif (0 == msg_param_decode(&msg->via.params, "received", &received)) {
\t\t\t\tif (0 == sa_decode(&reg->public_addr, received.p, received.l)) {
\t\t\t\t\tsa_set_port(&reg->public_addr, sa_port(&reg->laddr));
\t\t\t\t\treg->has_public_addr = true;
\t\t\t\t\tif (debug_fp) {
\t\t\t\t\t\tchar buf[64];
\t\t\t\t\t\tre_snprintf(buf, sizeof(buf), "%J", &reg->public_addr);
\t\t\t\t\t\tfprintf(debug_fp, "[407] Extracted public IP: %s\\n", buf);
\t\t\t\t\t\tfflush(debug_fp);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}'''
        
        new_code = '''\t\t/* Extract public IP from Via received parameter */
\t\t{
\t\t\tstruct pl received;
\t\t\tint decode_err = msg_param_decode(&msg->via.params, "received", &received);
\t\t\tif (debug_fp) {
\t\t\t\tfprintf(debug_fp, "[407] msg_param_decode result: %d\\n", decode_err);
\t\t\t\tfflush(debug_fp);
\t\t\t}
\t\t\tif (0 == decode_err) {
\t\t\t\tif (debug_fp) {
\t\t\t\t\tfprintf(debug_fp, "[407] received param: %.*s\\n",
\t\t\t\t\t        (int)received.l, received.p);
\t\t\t\t\tfflush(debug_fp);
\t\t\t\t}
\t\t\t\tint sa_err = sa_decode(&reg->public_addr, received.p, received.l);
\t\t\t\tif (debug_fp) {
\t\t\t\t\tfprintf(debug_fp, "[407] sa_decode result: %d\\n", sa_err);
\t\t\t\t\tfflush(debug_fp);
\t\t\t\t}
\t\t\t\tif (0 == sa_err) {
\t\t\t\t\tsa_set_port(&reg->public_addr, sa_port(&reg->laddr));
\t\t\t\t\treg->has_public_addr = true;
\t\t\t\t\tif (debug_fp) {
\t\t\t\t\t\tchar buf[64];
\t\t\t\t\t\tre_snprintf(buf, sizeof(buf), "%J", &reg->public_addr);
\t\t\t\t\t\tfprintf(debug_fp, "[407] Extracted public IP: %s\\n", buf);
\t\t\t\t\t\tfflush(debug_fp);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}'''
        
        content = content.replace(old_code, new_code)
        
        # Write the modified file
        with open(reg_c, 'w') as f:
            f.write(content)
        
        # Generate new patch
        print("Generating new patch...")
        result = subprocess.run(['diff', '-u', reg_c + '.orig', reg_c], capture_output=True, text=True)
        
        # Write the new patch
        patch_path = '/home/debdev/baresipui/baresip/patches/re-sipreg-public-ip.patch'
        with open(patch_path, 'w') as f:
            # Add proper header
            f.write('--- a/src/sipreg/reg.c\n')
            f.write('+++ b/src/sipreg/reg.c\n')
            # Skip the first two lines of diff output (they contain temp paths)
            lines = result.stdout.split('\n')[2:]
            f.write('\n'.join(lines))
        
        print(f"Updated patch written to {patch_path}")

if __name__ == '__main__':
    main()
