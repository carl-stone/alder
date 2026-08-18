# Bugs/Issues -- Things Carl doesn't like

This is a loose scratchpad for Carl to take notes on bugs or aspects of alder that should change.

## Bugs -- general

- the notebook should have some kind of automatic shutdown so it doesn't leave ports open and force the user to `kill` the process
- The min sepal length slider lets me slide but immediately resets to its default value and then at the top of the notebook there's a "widget value rejected" message
- I tried to add a new code cell with just the contents `summary(peng$Sepal.Length)` and when I ran it did nothing. Then, it said "Selection deleted" above row 1 of the cell. I think the bigger issue is that whatever is running the R code doesn't fucking work at all so you gotta really go back to the drawing board on something.
- I think there's an issue with it not running code every time I tell it to.

## UI/UX issues

- it appears that we're trying to put line numbers before each line of code in each cell, but currently it just prints the line numbers before the actual code.
An example of what this actually looks like, cell two of demo.R shows
> 1
> 2
> 3
>  library(alder)
>  library(ggplot2)
>  
Fix that so the line numbers actually denote the code lines
- I'd like it if you could click and drag to rearrange cells
- The cell selector stack on the right by the scrollbar doesn't work right
- Cell numbers should be displayed on the cells
- User flow to start/edit/open/stop server and/or notebooks is not clear.
- dataflow graph view is a fine start but the horizontal layout is unusable and the vertical layout doesn't look good either.

## wtf

- Why do we even have an option for SQL cells here? This is an R notebook.
- the syntax checker works too fast while I edit cells, so it is constantly telling me I have syntax errors as I'm typing. That's annoying.
- I encountered at least 2 errors while I was clicking around but you said there were no errors in the logs, so that's an error in itself.

## Things I actually *do* like

- App mode looks nice.
- In general the UI has a fine look.
