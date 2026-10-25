"""Sample one process tree without counting shared pages twice when PSS is available."""
import json
from pathlib import Path
import threading
import time
import psutil


class PeakSampler:
    def __init__(self, pids, output, interval=.25):
        self.pids, self.output, self.interval = pids, Path(output), interval
        self.phase, self.peak_rss, self.peak_pss = "startup", 0, 0
        self.phase_peaks = {}
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self): self.thread.start()
    def stop(self):
        self.stop_event.set(); self.thread.join()
        return {"sample_interval_s": self.interval, "peak_sum_rss_bytes": self.peak_rss,
                "peak_sum_pss_bytes": self.peak_pss, "phase_peaks": self.phase_peaks}

    def run(self):
        started = time.perf_counter()
        with self.output.open("w") as stream:
            while not self.stop_event.is_set():
                rss = pss = 0; found = set()
                for pid in self.pids():
                    try:
                        parent = psutil.Process(pid)
                        for process in [parent] + parent.children(recursive=True):
                            if process.pid in found: continue
                            found.add(process.pid); rss += process.memory_info().rss
                            try: pss += process.memory_full_info().pss
                            except (psutil.Error, AttributeError): pass
                    except psutil.Error: pass
                if found:
                    self.peak_rss = max(self.peak_rss, rss); self.peak_pss = max(self.peak_pss, pss)
                    peaks = self.phase_peaks.setdefault(self.phase, {"rss_bytes": 0, "pss_bytes": 0})
                    peaks["rss_bytes"] = max(peaks["rss_bytes"], rss); peaks["pss_bytes"] = max(peaks["pss_bytes"], pss)
                    stream.write(json.dumps({"elapsed_s": time.perf_counter() - started, "phase": self.phase,
                                             "rss_bytes": rss, "pss_bytes": pss, "processes": len(found)}) + "\n")
                self.stop_event.wait(self.interval)
