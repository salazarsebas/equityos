"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function DialogDemo() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        onClose={close}
        title="Stop replicating SCI6?"
        footer={
          <>
            <Button onClick={close}>Keep replicating</Button>
            <Button variant="destructive" onClick={close}>
              Stop replicating
            </Button>
          </>
        }
      >
        <p>
          Your wallet keeps every token it holds. Drift is no longer calculated and no rebalance is proposed for this
          index. Sample dialog: neither button changes anything.
        </p>
      </Dialog>
    </>
  );
}
