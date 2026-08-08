Devlog 2 - StudyBuddy


- left a pile of worksheets extracting **overnight** cuz i was sick of testing every fix against the same two papers. woke up to **9 worksheets, 713 questions, 353 pages**
- everything below only shipped after i swept it over all of that first. rule i have now, after **two earlier "fixes" that read perfectly and were wrong on real data**


**a question that shipped reading ?rac{44}{11}**


- i tell the model to write plain text. it writes LaTeX anyway
- sometimes that fails loudly. `\sqrt` isnt a valid JSON escape so the response explodes and i lose a page. thats fine?? at least i know
- the other half is the problem. **`\f` is a form feed and `\t` is a tab, both totally valid**, so `\frac{44}{11}` parses perfectly and quietly becomes a form feed followed by `rac{44}{11}`
- i had an AMC8 question in my database reading **`?rac{44}{11}`** and nothing anywhere reported a problem
- fix has to run **before the first parse**, not in the catch block, cuz the version that actually hurts u never throws
- it doubles the backslash on letter runs JSON would misread, but only the **six that collide (b f n r t u)** and only when the run spells a real command. otherwise a real line break stops being a line break, which is a fun way to make things worse


**questions torn in half by the page break**


- extraction reads one page at a time and never sees the page before or after. so a question ending at the bottom of page 3 with its answer choices at the top of page 4 is **never whole in either request**. five of them on the AMC8 paper
- one fix folds the halves back together. the other is for the worse case where the extractor returned **nothing at all** for the second half, cuz a bare block of answer choices isnt a question so the model just drops it. theyre still sitting in the next pages text layer tho, u just have to go get them
- sorting questions within a page needed its own module cuz **the bounding boxes lie**. question 4 came back with a top of 1428 and question 5 with 1379, so pure geometry puts them backwards
- **AMC8 went from 19 of 25 questions having their answer choices to 24 of 25**, zero false positives across 348 SHSAT pages


**stuff that broke**


- a worksheet told me it had **26 questions when the paper has 25**. the extra one was the axis labels off a diagram, and the SHSAT ones had rows that just said CONTINUE TO THE NEXT PAGE. **dropped 23 rows, all page furniture**
- then immediately shipped a followup bug where the card read **"Questions 25" next to "Unchecked 26"** cuz i filtered one count and forgot the other one lol
- tried just asking the model to return a carried answer block as half a question. produced **zero** of them and started relabelling stem-only questions as free response, which hides the damage from every check i have. reverted


**the landing page**


- every animation was gated behind `prefers-reduced-motion`, which sounds responsible until u find out **some managed windows installs ship with animation effects off by default**. so the page whose whole job is showing the product working was showing a static screenshot
- the hero panel gets **dealt onto the page like a card** now. needs a perspective on the parent or the rotations collapse into a shear and it just looks like a slide
- the forgetting curve draws itself left to right. `stroke-dashoffset` **does not work here**, `pathLength` is silently ignored under `vector-effect: non-scaling-stroke` so the dash tiles across the path instead of spanning it once. and i need non-scaling-stroke or the line renders **9x too thick**. used a page-coloured shutter instead


**next things:** that one AMC8 question needs reading off the page image since the text layer doesnt have it. and theres a cheaper reduced-motion compromise i wrote down but havent built.
