#!/usr/bin/env python3
"""
Script to add debug output to re-sipreg-public-ip.patch
This ensures proper tabs/spaces handling in the patch file.
"""

import sys

def read_patch(filename):
    with open(filename, 'r') as f:
        return f.read()

def create_enhanced_patch():
    # Read the original patch
    original_patch = read_patch('re-sipreg-public-ip.patch')
    
    # Split into lines
    lines = original_patch.split('\n')
    
    # Find the line with the 407 case and add debug output
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        new_lines.append(line)
        
        # After the 407 case check, add more debugging
        if line.strip() == '+\t\t/* Extract public IP from Via received parameter */':
            new_lines.append('+\t\t{')
            new_lines.append('+\t\t\tstruct pl received;')
            new_lines.append('+\t\t\tint decode_err = msg_param_decode(&msg->via.params, "received", &received);')
            new_lines.append('+\t\t\tif (debug_fp) {')
            new_lines.append('+\t\t\t\tfprintf(debug_fp, "[407] msg_param_decode result: %d\\n", decode_err);')
            new_lines.append('+\t\t\t\tfflush(debug_fp);')
            new_lines.append('+\t\t\t}')
            new_lines.append('+\t\t\tif (0 == decode_err) {')
            new_lines.append('+\t\t\t\tif (debug_fp) {')
            new_lines.append('+\t\t\t\t\tfprintf(debug_fp, "[407] received param: %.*s\\n",')
            new_lines.append('+\t\t\t\t\t        (int)received.l, received.p);')
            new_lines.append('+\t\t\t\t\tfflush(debug_fp);')
            new_lines.append('+\t\t\t\t}')
            new_lines.append('+\t\t\t\tint sa_err = sa_decode(&reg->public_addr, received.p, received.l);')
            new_lines.append('+\t\t\t\tif (debug_fp) {')
            new_lines.append('+\t\t\t\t\tfprintf(debug_fp, "[407] sa_decode result: %d\\n", sa_err);')
            new_lines.append('+\t\t\t\t\tfflush(debug_fp);')
            new_lines.append('+\t\t\t\t}')
            new_lines.append('+\t\t\t\tif (0 == sa_err) {')
            new_lines.append('+\t\t\t\t\tsa_set_port(&reg->public_addr, sa_port(&reg->laddr));')
            new_lines.append('+\t\t\t\t\treg->has_public_addr = true;')
            new_lines.append('+\t\t\t\t\tif (debug_fp) {')
            new_lines.append('+\t\t\t\t\t\tchar buf[64];')
            new_lines.append('+\t\t\t\t\t\tre_snprintf(buf, sizeof(buf), "%J", &reg->public_addr);')
            new_lines.append('+\t\t\t\t\t\tfprintf(debug_fp, "[407] Extracted public IP: %s\\n", buf);')
            new_lines.append('+\t\t\t\t\t\tfflush(debug_fp);')
            new_lines.append('+\t\t\t\t\t}')
            new_lines.append('+\t\t\t\t}')
            new_lines.append('+\t\t\t}')
            new_lines.append('+\t\t}')
            
            # Skip the original lines with this content
            i += 1
            while i < len(lines) and not (lines[i].strip().startswith(' \tif (reg->ls.failc') or 
                                          lines[i].strip().startswith('\tif (reg->ls.failc')):
                i += 1
            i -= 1  # Back one to not skip the next important line
        
        i += 1
    
    return '\n'.join(new_lines)

if __name__ == '__main__':
    enhanced_patch = create_enhanced_patch()
    
    # Write the enhanced patch
    with open('re-sipreg-public-ip-debug.patch', 'w') as f:
        f.write(enhanced_patch)
    
    print("Enhanced patch created: re-sipreg-public-ip-debug.patch")
