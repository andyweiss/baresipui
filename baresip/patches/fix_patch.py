#!/usr/bin/env python3
"""
Fix the patch file by ensuring proper formatting
"""

# Read the backup
with open('re-sipreg-public-ip.patch.backup', 'r') as f:
    lines = f.readlines()

# Find and replace the section with enhanced debugging
output = []
i = 0
while i < len(lines):
    line = lines[i]
    
    # Check if we're at the 407 case extraction section
    if '\t/* Extract public IP from Via received parameter */' in line:
        # Add the new enhanced version
        output.append(line)  # Keep the comment
        output.append('+\t\t{\n')
        output.append('+\t\t\tstruct pl received;\n')
        output.append('+\t\t\tint decode_err = msg_param_decode(&msg->via.params, "received", &received);\n')
        output.append('+\t\t\tif (debug_fp) {\n')
        output.append('+\t\t\t\tfprintf(debug_fp, "[407] msg_param_decode result: %d\\n", decode_err);\n')
        output.append('+\t\t\t\tfflush(debug_fp);\n')
        output.append('+\t\t\t}\n')
        output.append('+\t\t\tif (0 == decode_err) {\n')
        output.append('+\t\t\t\tif (debug_fp) {\n')
        output.append('+\t\t\t\t\tfprintf(debug_fp, "[407] received param: %.*s\\n",\n')
        output.append('+\t\t\t\t\t        (int)received.l, received.p);\n')
        output.append('+\t\t\t\t\tfflush(debug_fp);\n')
        output.append('+\t\t\t\t}\n')
        output.append('+\t\t\t\tint sa_err = sa_decode(&reg->public_addr, received.p, received.l);\n')
        output.append('+\t\t\t\tif (debug_fp) {\n')
        output.append('+\t\t\t\t\tfprintf(debug_fp, "[407] sa_decode result: %d\\n", sa_err);\n')
        output.append('+\t\t\t\t\tfflush(debug_fp);\n')
        output.append('+\t\t\t\t}\n')
        output.append('+\t\t\t\tif (0 == sa_err) {\n')
        output.append('+\t\t\t\t\tsa_set_port(&reg->public_addr, sa_port(&reg->laddr));\n')
        output.append('+\t\t\t\t\treg->has_public_addr = true;\n')
        output.append('+\t\t\t\t\tif (debug_fp) {\n')
        output.append('+\t\t\t\t\t\tchar buf[64];\n')
        output.append('+\t\t\t\t\t\tre_snprintf(buf, sizeof(buf), "%J", &reg->public_addr);\n')
        output.append('+\t\t\t\t\t\tfprintf(debug_fp, "[407] Extracted public IP: %s\\n", buf);\n')
        output.append('+\t\t\t\t\t\tfflush(debug_fp);\n')
        output.append('+\t\t\t\t\t}\n')
        output.append('+\t\t\t\t}\n')
        output.append('+\t\t\t}\n')
        output.append('+\t\t}\n')
        
        # Skip old lines until we find the closing brace and if statement
        i += 1
        while i < len(lines) and '\tif (reg->ls.failc > 1 && last_scode == msg->scode) {' not in lines[i]:
            i += 1
        # Don't skip the if statement itself, we want to keep it
        continue
    else:
        output.append(line)
    
    i += 1

# Update the hunk header
for i, line in enumerate(output):
    if line.startswith('@@ -224,7 +239,'):
        output[i] = '@@ -224,7 +239,50 @@\n'
    elif line.startswith('@@ -298,6 +344,'):
        output[i] = '@@ -298,6 +356,16 @@\n'
    elif line.startswith('@@ -307,7 +363,'):
        output[i] = '@@ -307,7 +375,24 @@\n'

# Write the fixed patch
with open('re-sipreg-public-ip.patch', 'w') as f:
    f.writelines(output)

print("Patch fixed and saved!")
