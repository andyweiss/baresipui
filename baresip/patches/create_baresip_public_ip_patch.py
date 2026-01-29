#!/usr/bin/env python3
"""
Create baresip patch to use public IP from registration for calls
This ensures proper tabs handling in the patch file.
"""

def create_patch():
    patch_content = """--- a/src/ua.c
+++ b/src/ua.c
@@ -933,9 +933,23 @@
 
 	if (sa_isset(laddr, SA_ADDR)) {
 		sa_cpy(&cprm.laddr, laddr);
 	}
 	else if (sa_isset(&ua->dst, SA_ADDR)) {
-		laddr = net_laddr_for(net, &ua->dst);
+		/* Try to use public IP from registration if available */
+		const struct sa *sipreg_addr = NULL;
+		struct le *le = list_head(&ua->regl);
+		if (le) {
+			struct sipreg *reg = list_ledata(le);
+			sipreg_addr = sipreg_laddr(reg);
+		}
+		
+		if (sipreg_addr && sa_isset(sipreg_addr, SA_ADDR)) {
+			/* Use public IP from REGISTER */
+			laddr = sipreg_addr;
+			info("ua: using public IP from registration: %j\\n", laddr);
+		}
+		else {
+			laddr = net_laddr_for(net, &ua->dst);
+		}
 		if (!sa_isset(laddr, SA_ADDR)) {
 			warning("ua: no laddr for %j\\n", &ua->dst);
 			sa_init(&ua->dst, AF_UNSPEC);
 			return EINVAL;
 		}
 
 		sa_init(&ua->dst, AF_UNSPEC);
 		sa_cpy(&cprm.laddr, laddr);
 	}
 
 	cprm.vidmode = vmode;
"""
    return patch_content

if __name__ == '__main__':
    patch = create_patch()
    
    # Write the patch
    with open('baresip-use-sipreg-public-ip.patch', 'w') as f:
        f.write(patch)
    
    print("Patch created: baresip-use-sipreg-public-ip.patch")
